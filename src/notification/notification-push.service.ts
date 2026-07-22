import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import type { NotificationRealtimeDto } from './notification.dto';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_RECEIPT_URL = 'https://exp.host/--/api/v2/push/getReceipts';
const EXPO_BATCH_SIZE = 100;
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
  error?: string;
};

export type ExpoPushPayload = {
  title: string;
  body: string;
  data: Record<string, unknown>;
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
const DELIVERY_MAX_ATTEMPTS = 5;

@Injectable()
export class NotificationPushService {
  private readonly logger = new Logger(NotificationPushService.name);
  // Optional. Required only when the Expo project has "Enhanced Security for
  // Push Notifications" enabled — Expo then rejects unauthenticated sends.
  private readonly expoAccessToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.expoAccessToken =
      this.config.get<string>('EXPO_ACCESS_TOKEN')?.trim() ?? '';
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
  async listActiveTokens(
    userId: string,
  ): Promise<Array<{ token: string; projectId: string | null }>> {
    const rows = await this.prisma.devicePushToken.findMany({
      where: { userID: userId, provider: 'expo', disabledAt: null },
      select: { token: true, projectId: true },
      orderBy: { updatedAt: 'desc' },
      take: 20,
    });
    return rows;
  }

  /**
   * 只向给定 token 发送（#88 的核心变化）：调用方（outbox）按投递行筛掉已
   * SENT/CONFIRMED/TERMINAL 的 token，部分失败重试不再殃及已收到的设备。
   * 返回每 token 的结论 + Expo ticket id。
   */
  async sendToTokens(
    tokens: Array<{ token: string; projectId: string | null }>,
    payload: ExpoPushPayload,
  ): Promise<TokenDeliveryOutcome[]> {
    if (tokens.length === 0) return [];

    // Expo project IDs must not be mixed in a single request when enhanced
    // security is enabled. Group first, then batch each project independently.
    const byProject = new Map<string, typeof tokens>();
    for (const token of tokens) {
      const key = token.projectId ?? '';
      const group = byProject.get(key) ?? [];
      group.push(token);
      byProject.set(key, group);
    }

    const outcomes: TokenDeliveryOutcome[] = [];
    for (const projectTokens of byProject.values()) {
      for (let i = 0; i < projectTokens.length; i += EXPO_BATCH_SIZE) {
        const batch = projectTokens.slice(i, i + EXPO_BATCH_SIZE);
        outcomes.push(
          ...(await this.sendBatch(
            batch.map((row) => row.token),
            payload,
          )),
        );
      }
    }

    // 只有「令牌已死」类错误才停用 token —— MessageTooBig 等消息级终态
    // 与 token 健康无关，误停会把活设备静音。
    const deadTokens = outcomes
      .filter(
        (outcome) =>
          outcome.status === 'TERMINAL' &&
          TERMINAL_TOKEN_ERRORS.has(outcome.error ?? ''),
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
  @Cron(CronExpression.EVERY_5_MINUTES)
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
    const pending = deliveries.filter((d) => !expired.includes(d));
    if (pending.length === 0) {
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
      return { processed: expired.length, done: true };
    }

    let processed = expired.length;
    const deadTokens: string[] = [];
    const retryOutboxIDs = new Set<string>();
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
      await this.prisma.notificationPushDelivery.update({
        where: { id: delivery.id },
        data: { status: 'FAILED', receiptCheckedAt: now, lastError: errorCode },
      });
      retryOutboxIDs.add(delivery.outboxID);
    }

    if (deadTokens.length > 0) {
      await this.prisma.devicePushToken.updateMany({
        where: { token: { in: deadTokens } },
        data: { disabledAt: new Date() },
      });
    }
    if (retryOutboxIDs.size > 0) {
      // 只把对应 outbox 拉回 PENDING；sweep 只会补发仍处 FAILED 的投递行。
      await this.prisma.notificationPushOutbox.updateMany({
        where: { id: { in: [...retryOutboxIDs] }, status: 'COMPLETED' },
        data: { status: 'PENDING', nextAttemptAt: now },
      });
    }
    return { processed, done: deliveries.length < RECEIPT_BATCH_SIZE };
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
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

  /** 单批发送：HTTP 层重试后返回逐 token 结论（ticket 顺序与请求一一对应）。 */
  private async sendBatch(
    tokens: string[],
    payload: ExpoPushPayload,
  ): Promise<TokenDeliveryOutcome[]> {
    const messages = tokens.map((token) => ({
      to: token,
      sound: 'default',
      title: payload.title,
      body: payload.body,
      data: payload.data,
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
