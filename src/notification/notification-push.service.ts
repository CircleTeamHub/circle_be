import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { TrackedCron } from '../metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import type { NotificationRealtimeDto } from './notification.dto';
import { createLoggingConfig } from 'src/logging/logging.config';
import { logExternalCallFailure } from 'src/logging/external-service.logger';
import { reportOperationalError } from 'src/logging/error-aggregation.service';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const JPUSH_PUSH_URL = 'https://api.jpush.cn/v3/push';
const EXPO_BATCH_SIZE = 100;
const JPUSH_BATCH_SIZE = 1000;
// 一次扇出里同时在途的 Expo 请求数:3000 人的群是 30 批,串行发太慢,全并发又会
// 撞 Expo 的速率限制。
const EXPO_SEND_CONCURRENCY = 4;
// 每个用户最多推几台设备(按最近注册的算)。
const ACTIVE_TOKENS_PER_USER = 20;
const EXPO_MAX_ATTEMPTS = 3;
// Hard cap on the Expo call. Node's global fetch (undici) applies no response
// timeout by default — a hung Expo endpoint would stall the outbox sweep.
const EXPO_PUSH_TIMEOUT_MS = 8_000;
const ACTIVE_TOKEN_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const DISABLED_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Expo 建议发送后稍等再取回执；回执在 Expo 侧保留约 24h。
const RECEIPT_MIN_AGE_MS = 15 * 60 * 1000;
const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const RECEIPT_BATCH_SIZE = 300;
// review 修复：单轮最多抽多少批 —— 300×20=6000 行/轮，远超预期峰值；
// 有上限只是防御性兜底（雪崩恢复时不至于一轮跑穿全表）。
const RECEIPT_MAX_BATCHES_PER_RUN = 20;

type ExpoPushTicket = {
  status?: string;
  id?: string;
  details?: { error?: string };
};

type ExpoPushReceipt = {
  status?: string;
  details?: { error?: string };
};

/** 单 token 的一次投递结果（#88：不再聚合成整通知一个结论）。 */
export type TokenDeliveryOutcome = {
  token: string;
  status: 'SENT' | 'RETRYABLE' | 'TERMINAL';
  ticketId?: string;
  /** Provider has no asynchronous receipt stage; persist as CONFIRMED. */
  receiptFinal?: boolean;
  error?: string;
};

export type PushTokenTarget = {
  token: string;
  projectId: string | null;
  provider?: 'expo' | 'jpush';
  platform?: 'ios' | 'android' | 'web';
};

export type ExpoPushPayload = {
  title: string;
  body: string;
  data: Record<string, unknown>;
  /** iOS 图标角标数(G-18);缺省不改角标。 */
  badge?: number;
  /**
   * 以下是 Expo 的投递选项,缺省时不出现在消息里(沿用各平台默认)。
   * priority:安卓默认 normal,省电模式下会被延后;即时消息要 high。
   */
  priority?: 'default' | 'normal' | 'high';
  /** 安卓通知渠道;设备上没建这个渠道时 expo-notifications 回落到默认渠道。 */
  channelId?: string;
  /** 安卓:同 tag 的新通知替换已显示的旧通知。 */
  tag?: string;
  /** iOS:按线程分组显示。 */
  threadId?: string;
  /** 设备离线时服务商保留多久(秒);缺省为服务商默认的 4 周。 */
  ttl?: number;
};

const RETRYABLE_TICKET_ERRORS = new Set([
  'MessageRateExceeded',
  'ExpoServerError',
  // review 修复：InvalidCredentials 是「项目 APNs/FCM 凭据配置坏了」这类
  // 运维故障 —— 修好凭据后推送应自动恢复。此前按死令牌处理会把所有受影响
  // 设备永久 disabledAt，凭据修复后用户依旧收不到推送。
  'InvalidCredentials',
]);
// 令牌本身已死，重试无意义且应停用 token。只有 token 级错误配进来；
// 项目级/消息级错误（InvalidCredentials/MessageTooBig）绝不 reap token。
const TERMINAL_TOKEN_ERRORS = new Set(['DeviceNotRegistered']);
const TERMINAL_JPUSH_TOKEN_ERRORS = new Set(['JPushInvalidRegistrationId']);
const DELIVERY_MAX_ATTEMPTS = 5;

@Injectable()
export class NotificationPushService {
  private readonly logger = new Logger(NotificationPushService.name);
  private readonly loggingConfig = createLoggingConfig();
  // Optional. Required only when the Expo project has "Enhanced Security for
  // Push Notifications" enabled — Expo then rejects unauthenticated sends.
  private readonly expoAccessToken: string;
  private readonly jpushAppKey: string;
  private readonly jpushMasterSecret: string;
  private readonly jpushApnsProduction: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.expoAccessToken =
      this.config.get<string>('EXPO_ACCESS_TOKEN')?.trim() ?? '';
    this.jpushAppKey = this.config.get<string>('JPUSH_APP_KEY')?.trim() ?? '';
    this.jpushMasterSecret =
      this.config.get<string>('JPUSH_MASTER_SECRET')?.trim() ?? '';
    const configuredJpushApnsProduction = this.config.get<boolean | string>(
      'JPUSH_APNS_PRODUCTION',
    );
    this.jpushApnsProduction =
      configuredJpushApnsProduction === true ||
      (typeof configuredJpushApnsProduction === 'string' &&
        configuredJpushApnsProduction.trim().toLowerCase() === 'true');
  }

  /** 组装推送 payload。外置成公开方法：outbox 第一次处理时快照进 DB（#88）。 */
  composeMessage(
    userId: string,
    notification: NotificationRealtimeDto,
  ): ExpoPushPayload {
    const actor = notification.fromUser?.nickname || 'CircleIM';
    const body =
      notification.type === 'TRACE_MENTION'
        ? notification.content ||
          notification.fromReply?.content ||
          this.fallbackBody(notification.type)
        : notification.content ||
          notification.fromReply?.content ||
          notification.fromCirclePost?.excerpt ||
          notification.fromTrace?.excerpt ||
          this.fallbackBody(notification.type);
    return {
      title: notification.type === 'SYSTEM' ? '系统通知' : actor,
      body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        toUserId: userId,
        ...(notification.fromUser
          ? {
              fromUserId: notification.fromUser.id,
              fromUserNickname: notification.fromUser.nickname,
            }
          : {}),
        ...(notification.type === 'SYSTEM' ? { route: 'system' } : {}),
        ...(notification.fromTrace?.id
          ? { traceId: notification.fromTrace.id }
          : {}),
        ...(notification.fromReply?.id
          ? { replyId: notification.fromReply.id }
          : {}),
        ...(notification.fromCirclePost?.id
          ? { postId: notification.fromCirclePost.id }
          : {}),
        ...(notification.fromInvitation?.id
          ? { invitationId: notification.fromInvitation.id }
          : {}),
        ...(notification.requestId
          ? { requestId: notification.requestId }
          : {}),
      },
    };
  }

  /** 当前活跃 token 清单（含 Expo projectId 分组信息），供 outbox 建投递行。 */
  async listActiveTokens(userId: string): Promise<PushTokenTarget[]> {
    const rows = await this.prisma.devicePushToken.findMany({
      where: { userID: userId, disabledAt: null },
      select: {
        token: true,
        projectId: true,
        provider: true,
        platform: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: ACTIVE_TOKENS_PER_USER,
    });
    return rows.map((row) => ({
      token: row.token,
      projectId: row.projectId,
      provider: row.provider as 'expo' | 'jpush',
      platform: row.platform as 'ios' | 'android' | 'web',
    }));
  }

  /**
   * 多个用户的活跃 token 一次查回(每人最近的 ACTIVE_TOKENS_PER_USER 个)。聊天大群
   * 扇出用:原来每个收件人一次查询,3000 人的群一条消息就是 3000 次往返。
   * 没有活跃 token 的用户不出现在结果里。
   */
  async listActiveTokensForUsers(
    userIds: string[],
  ): Promise<Map<string, PushTokenTarget[]>> {
    const byUser = new Map<string, PushTokenTarget[]>();
    if (userIds.length === 0) return byUser;
    const rows = await this.prisma.devicePushToken.findMany({
      where: { userID: { in: userIds }, disabledAt: null },
      select: {
        userID: true,
        token: true,
        projectId: true,
        provider: true,
        platform: true,
      },
      orderBy: { updatedAt: 'desc' },
    });
    for (const row of rows) {
      const tokens = byUser.get(row.userID) ?? [];
      if (tokens.length >= ACTIVE_TOKENS_PER_USER) continue;
      tokens.push({
        token: row.token,
        projectId: row.projectId,
        provider: row.provider as 'expo' | 'jpush',
        platform: row.platform as 'ios' | 'android' | 'web',
      });
      byUser.set(row.userID, tokens);
    }
    return byUser;
  }

  /**
   * 只向给定 token 发送（#88 的核心变化）：调用方（outbox）按投递行筛掉已
   * SENT/CONFIRMED/TERMINAL 的 token，部分失败重试不再殃及已收到的设备。
   * 返回每 token 的结论 + Expo ticket id。
   */
  async sendToTokens(
    tokens: PushTokenTarget[],
    payload: ExpoPushPayload,
  ): Promise<TokenDeliveryOutcome[]> {
    return this.sendMessages(tokens.map((token) => ({ ...token, payload })));
  }

  /**
   * 每条消息各带载荷(聊天扇出里每个收件人的角标不同),按 Expo 单次上限 100 条
   * 分批、有限并发发出。结论与入参一一对应(同一下标);死令牌就地停用。
   */
  async sendMessages(
    messages: Array<PushTokenTarget & { payload: ExpoPushPayload }>,
  ): Promise<TokenDeliveryOutcome[]> {
    if (messages.length === 0) return [];

    // Expo project IDs must not be mixed in a single request when enhanced
    // security is enabled. Group first, then batch each project independently.
    type Indexed = { index: number; token: string; payload: ExpoPushPayload };
    const byProject = new Map<string, Indexed[]>();
    messages.forEach((message, index) => {
      if (message.provider === 'jpush') return;
      const key = message.projectId ?? '';
      const group = byProject.get(key) ?? [];
      group.push({ index, token: message.token, payload: message.payload });
      byProject.set(key, group);
    });
    const batches: Indexed[][] = [];
    for (const projectMessages of byProject.values()) {
      for (let i = 0; i < projectMessages.length; i += EXPO_BATCH_SIZE) {
        batches.push(projectMessages.slice(i, i + EXPO_BATCH_SIZE));
      }
    }

    const outcomes = new Array<TokenDeliveryOutcome>(messages.length);
    for (let i = 0; i < batches.length; i += EXPO_SEND_CONCURRENCY) {
      const chunk = batches.slice(i, i + EXPO_SEND_CONCURRENCY);
      const settled = await Promise.all(
        chunk.map((batch) => this.sendBatch(batch)),
      );
      chunk.forEach((batch, batchIndex) => {
        batch.forEach((entry, entryIndex) => {
          outcomes[entry.index] = settled[batchIndex][entryIndex];
        });
      });
    }

    const jpushMessages = messages
      .map((message, index) => ({ ...message, index }))
      .filter((message) => message.provider === 'jpush');
    const jpushOutcomes = await this.sendJPushMessages(jpushMessages);
    jpushOutcomes.forEach(({ index, outcome }) => {
      outcomes[index] = outcome;
    });

    // 只有「令牌已死」类错误才停用 token —— MessageTooBig 等消息级终态
    // 与 token 健康无关，误停会把活设备静音。
    const deadTokens = outcomes
      .filter(
        (outcome) =>
          outcome.status === 'TERMINAL' &&
          (TERMINAL_TOKEN_ERRORS.has(outcome.error ?? '') ||
            TERMINAL_JPUSH_TOKEN_ERRORS.has(outcome.error ?? '')),
      )
      .map((outcome) => outcome.token);
    if (deadTokens.length > 0) {
      await this.prisma.devicePushToken.updateMany({
        where: { token: { in: deadTokens } },
        data: { disabledAt: new Date() },
      });
    }
    return outcomes;
  }

  /**
   * Expo 回执轮询（#88）：同步 ticket 只代表「Expo 收下了」，投递失败
   * （尤其 DeviceNotRegistered）经常只出现在异步回执里 —— 不轮询就永远
   * 不 reap。SENT 且发出 ≥15min 的投递行分批查询；
   * - ok → CONFIRMED；
   * - 死令牌错误 → TERMINAL + 停用 token；
   * - 可重试错误 → FAILED + 对应 outbox 置回 PENDING（sweep 只补发该 token）；
   * - 超过 24h 取不到回执 → CONFIRMED（Expo 侧已过期，无从考证，按送达计）。
   */
  // review 修复：30 分钟 × 300 行的吞吐上限是 600 行/小时，超过即积压，
  // 24h 后被「过期视同送达」吞掉 —— DeviceNotRegistered 与可重试错误全被
  // 静默错过。加密频率到 5 分钟，且单轮循环抽批直到抽干（对 Expo 尚未生成
  // 回执的行记入跳过清单，避免同轮空转重查）。
  @TrackedCron(CronExpression.EVERY_5_MINUTES, 'push_receipt_poll')
  async pollReceipts(now: Date = new Date()): Promise<number> {
    let total = 0;
    const skipIDs: string[] = [];
    for (let batch = 0; batch < RECEIPT_MAX_BATCHES_PER_RUN; batch += 1) {
      const result = await this.pollReceiptBatch(now, skipIDs);
      total += result.processed;
      if (result.done) break;
    }
    return total;
  }

  private async pollReceiptBatch(
    now: Date,
    skipIDs: string[],
  ): Promise<{ processed: number; done: boolean }> {
    const deliveries = await this.prisma.notificationPushDelivery.findMany({
      where: {
        status: 'SENT',
        ticketID: { not: null },
        sentAt: { lte: new Date(now.getTime() - RECEIPT_MIN_AGE_MS) },
        ...(skipIDs.length > 0 ? { id: { notIn: skipIDs } } : {}),
      },
      orderBy: { sentAt: 'asc' },
      take: RECEIPT_BATCH_SIZE,
      select: {
        id: true,
        ticketID: true,
        token: true,
        outboxID: true,
        sentAt: true,
      },
    });
    if (deliveries.length === 0) return { processed: 0, done: true };

    const expired = deliveries.filter(
      (d) =>
        d.sentAt && d.sentAt.getTime() < now.getTime() - RECEIPT_MAX_AGE_MS,
    );
    if (expired.length > 0) {
      await this.prisma.notificationPushDelivery.updateMany({
        where: { id: { in: expired.map((d) => d.id) } },
        data: {
          status: 'CONFIRMED',
          receiptCheckedAt: now,
          lastError: 'receipt-expired-assumed-delivered',
        },
      });
    }
    const settledOutboxIDs = new Set(expired.map((d) => d.outboxID));
    const pending = deliveries.filter((d) => !expired.includes(d));
    if (pending.length === 0) {
      await this.reconcileCompletedOutboxes(settledOutboxIDs);
      return {
        processed: expired.length,
        done: deliveries.length < RECEIPT_BATCH_SIZE,
      };
    }

    let receipts: Record<string, ExpoPushReceipt>;
    try {
      const response = await fetch(EXPO_RECEIPT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.expoAccessToken
            ? { Authorization: `Bearer ${this.expoAccessToken}` }
            : {}),
        },
        body: JSON.stringify({ ids: pending.map((d) => d.ticketID) }),
        signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = (await response.json()) as {
        data?: Record<string, ExpoPushReceipt>;
      };
      receipts = json.data ?? {};
    } catch (error) {
      // 拉不到回执不改状态，下一轮 cron 再试；本轮直接收工（Expo 出问题时
      // 继续抽批只会连环失败）。
      this.logger.warn(
        `Expo receipt poll failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      logExternalCallFailure(this.logger, {
        enabled: this.loggingConfig.externalLogOn,
        service: 'expo_push',
        operation: 'get_receipts',
        error,
      });
      reportOperationalError(error, {
        component: 'NotificationPushService',
        operation: 'pollReceipts',
        kind: 'expo_push',
      });
      await this.reconcileCompletedOutboxes(settledOutboxIDs);
      return { processed: expired.length, done: true };
    }

    let processed = expired.length;
    const deadTokens: string[] = [];
    for (const delivery of pending) {
      const receipt = delivery.ticketID
        ? receipts[delivery.ticketID]
        : undefined;
      if (!receipt) {
        // Expo 还没生成回执：状态不动，但记入本轮跳过清单，
        // 否则排空循环会反复捞到同一批「最老的无回执行」空转。
        skipIDs.push(delivery.id);
        continue;
      }
      settledOutboxIDs.add(delivery.outboxID);
      processed += 1;
      if (receipt.status === 'ok') {
        await this.prisma.notificationPushDelivery.update({
          where: { id: delivery.id },
          data: { status: 'CONFIRMED', receiptCheckedAt: now, lastError: null },
        });
        continue;
      }
      const errorCode = receipt.details?.error ?? 'UnknownExpoReceiptError';
      if (TERMINAL_TOKEN_ERRORS.has(errorCode)) {
        deadTokens.push(delivery.token);
        await this.prisma.notificationPushDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'TERMINAL',
            receiptCheckedAt: now,
            lastError: errorCode,
          },
        });
        continue;
      }
      // round 3 review：FAILED 标记与 outbox 重开必须同事务 —— 行改成
      // FAILED 后 outbox 若没能拉回 PENDING（写失败），这条可重试失败就
      // 永远没有下一次 sweep。
      await this.prisma.$transaction([
        this.prisma.notificationPushDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'FAILED',
            receiptCheckedAt: now,
            lastError: errorCode,
          },
        }),
        this.prisma.notificationPushOutbox.updateMany({
          where: { id: delivery.outboxID, status: 'COMPLETED' },
          data: { status: 'PENDING', nextAttemptAt: now },
        }),
      ]);
    }

    if (deadTokens.length > 0) {
      await this.prisma.devicePushToken.updateMany({
        where: { token: { in: deadTokens } },
        data: { disabledAt: new Date() },
      });
    }
    await this.reconcileCompletedOutboxes(settledOutboxIDs);
    // requeue 已在上方与行状态同事务完成。
    return { processed, done: deliveries.length < RECEIPT_BATCH_SIZE };
  }

  private async reconcileCompletedOutboxes(
    outboxIDs: ReadonlySet<string>,
  ): Promise<void> {
    if (outboxIDs.size === 0) return;
    const ids = [...outboxIDs];

    // review P2：原实现「每个已结算 outbox 一个事务 + 两次 count」。一次
    // pollReceipts 最多 300 行、cron 每轮最多 20 批，若回执分散在很多不同
    // outbox 上，可累积到数千个事务、上万次 count，让高峰期收据轮询变成
    // DB-bound。改为对整批 outboxID 各做一次分组聚合，再用一条 updateMany
    // 批量终结 —— 与逐个判定语义完全一致（无 SENT 待回执 且 有耗尽的 FAILED）。
    const [stillAwaiting, exhaustedGroups] = await Promise.all([
      // 仍有 SENT（等回执）的 outbox：还不能终结
      this.prisma.notificationPushDelivery.groupBy({
        by: ['outboxID'],
        where: { outboxID: { in: ids }, status: 'SENT' },
      }),
      // 存在「尝试已耗尽的 FAILED」的 outbox
      this.prisma.notificationPushDelivery.groupBy({
        by: ['outboxID'],
        where: {
          outboxID: { in: ids },
          status: 'FAILED',
          attempts: { gte: DELIVERY_MAX_ATTEMPTS },
        },
      }),
    ]);

    const stillAwaitingIDs = new Set(
      stillAwaiting.map((group) => group.outboxID),
    );
    const terminalIDs = exhaustedGroups
      .map((group) => group.outboxID)
      .filter((outboxID) => !stillAwaitingIDs.has(outboxID));

    if (terminalIDs.length === 0) return;

    // status: 'COMPLETED' 守卫不变 —— 本轮已被 requeue 拉回 PENDING 的 outbox
    // 自动排除；COMPLETED 的 outbox 不会再新增 delivery，故 SENT 计数只减不增，
    // 批量终结安全。
    await this.prisma.notificationPushOutbox.updateMany({
      where: { id: { in: terminalIDs }, status: 'COMPLETED' },
      data: {
        status: 'TERMINAL',
        lastError: 'delivery-attempts-exhausted',
      },
    });
  }

  @TrackedCron(CronExpression.EVERY_DAY_AT_4AM, 'push_stale_token_cleanup')
  async deleteStaleTokens(): Promise<{ count: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext('notification-token-cleanup')) AS acquired
      `;
        if (!lock?.acquired) return { count: 0 };

        return tx.devicePushToken.deleteMany({
          where: {
            OR: [
              {
                updatedAt: {
                  lt: new Date(Date.now() - ACTIVE_TOKEN_MAX_AGE_MS),
                },
              },
              {
                disabledAt: {
                  lt: new Date(Date.now() - DISABLED_TOKEN_MAX_AGE_MS),
                },
              },
            ],
          },
        });
      },
      { timeout: 60_000 },
    );
  }

  private fallbackBody(type: string): string {
    if (type === 'TRACE_LIKE') return '点赞了你的动态';
    if (type === 'TRACE_COMMENT') return '评论了你的动态';
    if (type === 'COMMENT_REPLY') return '回复了你的评论';
    if (type === 'TRACE_MENTION') return '在动态评论中提到了你';
    if (type === 'FRIEND_REQUEST_RECEIVED') return '请求添加你为好友';
    if (type === 'FRIEND_REQUEST_ACCEPTED') return '已通过你的好友申请';
    if (type === 'FRIEND_REQUEST_REJECTED') return '已拒绝你的好友申请';
    if (type === 'PROFILE_LIKE') return '赞了你的资料';
    if (type === 'CIRCLE_VERIFICATION_REQUESTED') return '邀请你验证入圈申请';
    if (type === 'CIRCLE_POST_PUBLISHED') return '在圈子发布了新活动';
    if (type === 'CIRCLE_POST_SIGNUP_CREATED') return '报名了你的帖子';
    if (type === 'CIRCLE_POST_AUTO_ENDED') return '你的帖子报名已结束';
    if (type === 'CIRCLE_POST_COLLABORATION_RECOGNIZED')
      return '认可了你的活动协作';
    return '你有一条新通知';
  }

  private async sendJPushMessages(
    messages: Array<
      PushTokenTarget & { payload: ExpoPushPayload; index: number }
    >,
  ): Promise<Array<{ index: number; outcome: TokenDeliveryOutcome }>> {
    if (messages.length === 0) return [];
    if (!this.jpushAppKey || !this.jpushMasterSecret) {
      return messages.map(({ index, token }) => ({
        index,
        outcome: {
          token,
          status: 'RETRYABLE',
          error: 'JPushNotConfigured',
        },
      }));
    }

    const groups = new Map<string, typeof messages>();
    for (const message of messages) {
      const key = JSON.stringify({
        platform: message.platform ?? 'android',
        payload: message.payload,
      });
      const group = groups.get(key) ?? [];
      group.push(message);
      groups.set(key, group);
    }

    const results: Array<{ index: number; outcome: TokenDeliveryOutcome }> = [];
    for (const group of groups.values()) {
      for (let offset = 0; offset < group.length; offset += JPUSH_BATCH_SIZE) {
        const batch = group.slice(offset, offset + JPUSH_BATCH_SIZE);
        const outcomes = await this.sendJPushBatch(batch);
        outcomes.forEach((outcome, index) => {
          results.push({ index: batch[index].index, outcome });
        });
      }
    }
    return results;
  }

  private async sendJPushBatch(
    batch: Array<PushTokenTarget & { payload: ExpoPushPayload }>,
  ): Promise<TokenDeliveryOutcome[]> {
    const payload = batch[0].payload;
    const platforms = [
      ...new Set(
        batch
          .map((entry) => entry.platform)
          .filter(
            (platform): platform is 'ios' | 'android' =>
              platform === 'ios' || platform === 'android',
          ),
      ),
    ];
    const platform = platforms.length > 0 ? platforms : ['android', 'ios'];
    const notification = {
      alert: payload.body,
      ...(platform.includes('android')
        ? {
            android: {
              alert: payload.body,
              title: payload.title,
              extras: payload.data,
            },
          }
        : {}),
      ...(platform.includes('ios')
        ? {
            ios: {
              alert: { title: payload.title, body: payload.body },
              sound: 'default',
              ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
              ...(payload.threadId ? { 'thread-id': payload.threadId } : {}),
              extras: payload.data,
            },
          }
        : {}),
    };

    try {
      const credentials = `${this.jpushAppKey}:${this.jpushMasterSecret}`;
      const response = await fetch(JPUSH_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(credentials).toString('base64')}`,
        },
        body: JSON.stringify({
          platform,
          audience: { registration_id: batch.map((entry) => entry.token) },
          notification,
          options: {
            time_to_live: payload.ttl ?? 24 * 60 * 60,
            apns_production: this.jpushApnsProduction,
            ...(payload.tag ? { apns_collapse_id: payload.tag } : {}),
          },
        }),
        signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
      });
      if (response.ok) {
        return batch.map(({ token }) => ({
          token,
          status: 'SENT',
          receiptFinal: true,
        }));
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: { code?: number; message?: string };
      };
      const code = body.error?.code;
      if ((code === 1003 || code === 1011) && batch.length > 1) {
        const nested = await Promise.all(
          batch.map((entry) => this.sendJPushBatch([entry])),
        );
        return nested.flat();
      }
      if (code === 1003 || code === 1011) {
        return batch.map(({ token }) => ({
          token,
          status: 'TERMINAL',
          error: 'JPushInvalidRegistrationId',
        }));
      }
      const retryable =
        response.status === 401 ||
        response.status === 403 ||
        response.status === 429 ||
        response.status >= 500 ||
        code === 1000 ||
        code === 1004;
      return batch.map(({ token }) => ({
        token,
        status: retryable ? 'RETRYABLE' : 'TERMINAL',
        error: `JPushError:${code ?? response.status}`,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logExternalCallFailure(this.logger, {
        enabled: this.loggingConfig.externalLogOn,
        service: 'jpush',
        operation: 'send',
        error,
      });
      reportOperationalError(error, {
        component: 'NotificationPushService',
        operation: 'sendToTokens',
        kind: 'jpush',
      });
      return batch.map(({ token }) => ({
        token,
        status: 'RETRYABLE',
        error: message,
      }));
    }
  }

  /** 单批发送：HTTP 层重试后返回逐 token 结论（ticket 顺序与请求一一对应）。 */
  private async sendBatch(
    batch: Array<{ token: string; payload: ExpoPushPayload }>,
  ): Promise<TokenDeliveryOutcome[]> {
    const tokens = batch.map((entry) => entry.token);
    const messages = batch.map(({ token, payload }) => ({
      to: token,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data,
      ...(payload.badge !== undefined ? { badge: payload.badge } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.channelId !== undefined
        ? { channelId: payload.channelId }
        : {}),
      ...(payload.tag !== undefined ? { tag: payload.tag } : {}),
      ...(payload.threadId !== undefined ? { threadId: payload.threadId } : {}),
      ...(payload.ttl !== undefined ? { ttl: payload.ttl } : {}),
    }));

    for (let attempt = 1; attempt <= EXPO_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.expoAccessToken
              ? { Authorization: `Bearer ${this.expoAccessToken}` }
              : {}),
          },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = (await response.json()) as { data?: ExpoPushTicket[] };
        const tickets = json.data ?? [];
        if (tickets.length !== tokens.length) {
          // 数量对不上无法逐一归因，整批按可重试处理。
          return tokens.map((token) => ({
            token,
            status: 'RETRYABLE',
            error: 'MissingExpoPushTicket',
          }));
        }
        return tickets.map((ticket, index) =>
          this.classifyTicket(tokens[index], ticket),
        );
      } catch (error) {
        if (attempt === EXPO_MAX_ATTEMPTS) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Expo push send failed after ${attempt} attempts: ${message}`,
          );
          logExternalCallFailure(this.logger, {
            enabled: this.loggingConfig.externalLogOn,
            service: 'expo_push',
            operation: 'send',
            error,
          });
          // outbox 会退避重试,所以这不是丢推送;但 Expo 持续不可达时只有
          // 这里能把「推送整体停摆」送进错误聚合(按签名 60s 去重)。
          reportOperationalError(error, {
            component: 'NotificationPushService',
            operation: 'sendToTokens',
            kind: 'expo_push',
          });
          return tokens.map((token) => ({
            token,
            status: 'RETRYABLE',
            error: message,
          }));
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * 2 ** (attempt - 1)),
        );
      }
    }
    return tokens.map((token) => ({
      token,
      status: 'RETRYABLE',
      error: 'Expo delivery failed',
    }));
  }

  private classifyTicket(
    token: string,
    ticket: ExpoPushTicket,
  ): TokenDeliveryOutcome {
    if (ticket.status === 'ok') {
      return { token, status: 'SENT', ticketId: ticket.id };
    }
    if (ticket.status !== 'error') {
      return { token, status: 'RETRYABLE', error: 'UnknownExpoTicketStatus' };
    }
    const errorCode = ticket.details?.error ?? 'UnknownExpoTicketError';
    if (TERMINAL_TOKEN_ERRORS.has(errorCode)) {
      return { token, status: 'TERMINAL', error: errorCode };
    }
    if (
      RETRYABLE_TICKET_ERRORS.has(errorCode) ||
      errorCode === 'UnknownExpoTicketError'
    ) {
      return { token, status: 'RETRYABLE', error: errorCode };
    }
    // 其它 ticket 错误（MessageTooBig 等）与 token 无关且重试无益：终态但不停用 token。
    return { token, status: 'TERMINAL', error: errorCode };
  }
}

export { DELIVERY_MAX_ATTEMPTS };
