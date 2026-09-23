import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  type ExpoPushPayload,
  NotificationPushService,
  type TokenDeliveryOutcome,
} from 'src/notification/notification-push.service';
import { ChatBroadcastService } from './chat-broadcast.service';
import { CHAT_PUSH_CHANNEL_ID } from './chat.constants';
import type { ChatMessageDto } from './chat.types';
import { reportOperationalError } from 'src/logging/error-aggregation.service';
import {
  PrivacySettingsService,
  type SelfDestructPolicy,
} from 'src/privacy/privacy-settings.service';

/**
 * 聊天离线推送(best-effort):socket 广播覆盖在线端,本服务只管离线成员。
 *
 * 刻意不走 NotificationPushOutbox —— 那条管道 1:1 挂在 Notification 行上,
 * 聊天消息若逐条建 Notification 会灌爆通知中心;而聊天推送天然可丢
 * (消息本体在库里,漏推 ≠ 丢消息),直发 + 失败记日志即可。
 *
 * 分流规则(微信式):发送者不推;有前台连接的成员不推;免打扰不推,
 * 但 @提及/@所有人 穿透免打扰。
 */
const PREVIEW_MAX_LENGTH = 60;
/** 设备离线超过一天,消息通知就不再补发了 —— 打开 App 看未读即可。 */
const CHAT_PUSH_TTL_SECONDS = 24 * 60 * 60;
/** 阅后即焚消息的推送正文:通知栏里留着原文,焚毁就形同虚设。 */
const BURN_PREVIEW = '[阅后即焚消息]';
/**
 * 一条消息最多考虑多少个在座成员。圈子扩容上限 3000,留一倍余量;
 * 这是失控兜底而不是常规截断 —— 触顶会打 warn。
 */
const PUSH_TARGET_CAP = 6000;
/** 附带 badge 的最大扇出规模:超过则跳过逐人未读聚合(照常推送,只是无数字)。 */
const BADGE_TARGETS_MAX = 200;

/**
 * 同一会话的推送合并窗口。
 *
 * 原来每条消息提交后立刻各推一次:活跃群里离线的人被连环推送,每条还要逐人查
 * token、算角标。现在窗口内只推最新那条(squady 同款的「延迟 1 秒、只留最新」)。
 *
 * - 窗口从第一条开始计时,**不随后续消息顺延**:顺延的话一场连续的群聊永远推不出去。
 * - 被 @ 的人与 @所有人 按窗口内累计的点名穿透免打扰,预览用点名他的那一条 ——
 *   否则「@你 看一下」会被紧跟着的一句「好的」盖掉,等于没通知。
 * - 窗口顺带给了别的设备先读的时间:发推前按已读水位再筛一遍。
 * - 窗口内被撤回/焚毁的消息不推:DTO 是入窗那一刻的快照,正文还在上面。
 *
 * 窗口在进程内存里:多实例下同一会话的消息落在不同实例,各自合并(最坏多推一条);
 * 进程退出时 onModuleDestroy 把积压的窗口推掉。
 */
export const CHAT_PUSH_COALESCE_MS = 1_000;

/**
 * 聊天推送的投递选项:高优先级走聊天渠道;安卓同一会话的新通知替换旧的(tag),
 * iOS 按会话分组(threadId);点名的通知单独一个 tag。阅后即焚的消息过了焚毁时限
 * 就不再补发。
 */
function deliveryOptions(
  message: ChatMessageDto,
  mention: boolean,
): Pick<
  ExpoPushPayload,
  'priority' | 'channelId' | 'tag' | 'threadId' | 'ttl'
> {
  const burnSeconds = message.burnDurationSec ?? 0;
  return {
    priority: 'high',
    channelId: CHAT_PUSH_CHANNEL_ID,
    tag: mention ? `${message.conversationId}:mention` : message.conversationId,
    threadId: message.conversationId,
    ttl:
      burnSeconds > 0
        ? Math.min(CHAT_PUSH_TTL_SECONDS, burnSeconds)
        : CHAT_PUSH_TTL_SECONDS,
  };
}

interface PendingPushWindow {
  latest: ChatMessageDto;
  /** 窗口内被点名的人 → 点名他的最新一条。 */
  mentioned: Map<string, ChatMessageDto>;
  /** 窗口内最新的一条 @所有人。 */
  atAll: ChatMessageDto | null;
  timer: NodeJS.Timeout;
}

interface PushSeat {
  userID: string;
  muted: boolean;
}

interface PushConversation {
  type: string;
  circleID: string | null;
  tempChatID: string | null;
  name: string | null;
}

@Injectable()
export class ChatPushService implements OnModuleDestroy {
  private readonly logger = new Logger(ChatPushService.name);
  private readonly pending = new Map<string, PendingPushWindow>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: NotificationPushService,
    private readonly broadcast: ChatBroadcastService,
    private readonly privacySettings: PrivacySettingsService,
  ) {}

  /**
   * 网关/系统消息在广播后调用:只把消息放进所在会话的合并窗口,立即返回。
   * 推送在窗口结束时发出;任何失败只记日志,绝不抛给调用方。
   */
  onMessageBroadcast(message: ChatMessageDto): Promise<void> {
    const existing = this.pending.get(message.conversationId);
    if (existing) {
      this.absorb(existing, message);
      return Promise.resolve();
    }
    const timer = setTimeout(
      () => this.flush(message.conversationId),
      CHAT_PUSH_COALESCE_MS,
    );
    timer.unref?.();
    const window: PendingPushWindow = {
      latest: message,
      mentioned: new Map(),
      atAll: null,
      timer,
    };
    this.absorb(window, message);
    this.pending.set(message.conversationId, window);
    return Promise.resolve();
  }

  /** 立刻结束所有积压的窗口,并等在途推送落定(停机与测试用)。 */
  async flushPending(): Promise<void> {
    for (const conversationId of [...this.pending.keys()]) {
      this.flush(conversationId);
    }
    await Promise.all([...this.inFlight]);
  }

  onModuleDestroy(): Promise<void> {
    return this.flushPending();
  }

  private absorb(window: PendingPushWindow, message: ChatMessageDto): void {
    if (message.height >= window.latest.height) window.latest = message;
    if (
      message.content['atAll'] === true &&
      (window.atAll === null || message.height >= window.atAll.height)
    ) {
      window.atAll = message;
    }
    for (const userId of this.mentionedUserIds(message)) {
      const prior = window.mentioned.get(userId);
      if (!prior || message.height >= prior.height) {
        window.mentioned.set(userId, message);
      }
    }
  }

  private flush(conversationId: string): void {
    const window = this.pending.get(conversationId);
    if (!window) return;
    this.pending.delete(conversationId);
    clearTimeout(window.timer);
    const run: Promise<void> = this.dispatchWindow(window)
      .catch((error: unknown) => {
        this.logger.warn(
          `chat push dispatch failed message=${window.latest.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        reportOperationalError(error, {
          component: 'ChatPushService',
          operation: 'dispatch',
          kind: 'push',
        });
      })
      .finally(() => {
        this.inFlight.delete(run);
      });
    this.inFlight.add(run);
  }

  private async dispatchWindow(window: PendingPushWindow): Promise<void> {
    const { latest } = window;
    const conversationId = latest.conversationId;
    const [seats, conversation, foregroundTokens, stillVisible] =
      await Promise.all([
        this.listSeats(conversationId, latest.height),
        this.prisma.chatConversation.findUnique({
          where: { id: conversationId },
          select: {
            type: true,
            circleID: true,
            tempChatID: true,
            name: true,
          },
        }),
        this.broadcast.getForegroundPushTokensInConversation(conversationId),
        this.loadStillVisibleMessageIds(window),
      ]);
    if (!conversation || seats.length === 0) return;

    const chosen = new Map<string, ChatMessageDto>();
    // 正开着 App 的设备不在这里排除,而是在发送时按 token 跳过(见 sendToRecipients):
    // 电脑上开着网页版不该让手机收不到推送。
    for (const member of seats) {
      const message = this.messageFor(window, member);
      if (!message || !stillVisible.has(message.id)) continue;
      if (message.sender?.id === member.userID) continue;
      chosen.set(member.userID, message);
    }
    if (chosen.size === 0) return;
    // 合并窗口里另一台设备可能已经读到/清掉了这一条。
    const caughtUp = await this.loadCaughtUpUserIds(conversationId, chosen);
    // 按「推哪条 + 是不是点名他的」分组:点名的通知单独一个 tag,免得被同一
    // 会话里后面的普通消息替换掉。
    const groups = new Map<
      string,
      { message: ChatMessageDto; mention: boolean; recipients: string[] }
    >();
    for (const [userId, message] of chosen) {
      if (caughtUp.has(userId)) continue;
      const mention =
        window.mentioned.get(userId) === message || window.atAll === message;
      const key = `${message.id}:${mention ? 'mention' : 'stream'}`;
      const group = groups.get(key) ?? { message, mention, recipients: [] };
      group.recipients.push(userId);
      groups.set(key, group);
    }
    if (groups.size === 0) return;

    const everyone = [...groups.values()].flatMap((group) => group.recipients);
    // G-18:小规模扇出附 per-recipient 角标(iOS 杀后台也有数字)。大群跳过 ——
    // 逐人聚合未读的代价与收益不成比;拿不到就不带 badge,推送照发。
    const [badges, viewerPolicies] = await Promise.all([
      everyone.length <= BADGE_TARGETS_MAX
        ? this.loadUnreadBadges(everyone)
        : Promise.resolve(new Map<string, number>()),
      this.privacySettings.getSelfDestructPoliciesForUsers(everyone),
    ]);
    for (const { message, mention, recipients } of groups.values()) {
      const payload = {
        ...(await this.composePayload(message, conversation)),
        ...deliveryOptions(message, mention),
      };
      await this.sendToRecipients(
        message,
        recipients,
        payload,
        badges,
        foregroundTokens,
        viewerPolicies,
      );
    }
  }

  /** 免打扰的人只收点名他的那条;其余人收最新一条(被点名则优先点名那条)。 */
  private messageFor(
    window: PendingPushWindow,
    member: PushSeat,
  ): ChatMessageDto | null {
    const personal = window.mentioned.get(member.userID);
    if (member.muted) return personal ?? window.atAll ?? null;
    return personal ?? window.latest;
  }

  /**
   * 已经读到或清掉「要推给他的那条」的人。
   *
   * 不并进座位查询:那条查询只取 ChatMember_fanout_idx 覆盖的列(3000 人群每条
   * 消息一次,回表代价见 chat-member-fanout-index-migration.spec)。这里只查
   * 候选收件人里水位越过窗口最早一条的,走 (conversationID, userID) 唯一索引。
   */
  private async loadCaughtUpUserIds(
    conversationId: string,
    chosen: Map<string, ChatMessageDto>,
  ): Promise<Set<string>> {
    const floor = Math.min(
      ...[...chosen.values()].map((message) => message.height),
    );
    const rows = await this.prisma.chatMember.findMany({
      where: {
        conversationID: conversationId,
        userID: { in: [...chosen.keys()] },
        OR: [
          { lastReadHeight: { gte: floor } },
          { clearedBeforeHeight: { gte: floor } },
        ],
      },
      select: { userID: true, lastReadHeight: true, clearedBeforeHeight: true },
    });
    const caughtUp = new Set<string>();
    for (const row of rows) {
      const message = chosen.get(row.userID);
      if (!message) continue;
      if (
        row.lastReadHeight >= message.height ||
        row.clearedBeforeHeight >= message.height
      ) {
        caughtUp.add(row.userID);
      }
    }
    return caughtUp;
  }

  /** 入窗之后被撤回/焚毁的消息不能推:DTO 快照上还带着正文。 */
  private async loadStillVisibleMessageIds(
    window: PendingPushWindow,
  ): Promise<Set<string>> {
    const ids = new Set<string>([
      window.latest.id,
      ...[...window.mentioned.values()].map((message) => message.id),
      ...(window.atAll ? [window.atAll.id] : []),
    ]);
    const rows = await this.prisma.chatMessage.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, revokedAt: true, deleted: true },
    });
    return new Set(
      rows
        .filter((row) => row.revokedAt === null && !row.deleted)
        .map((row) => row.id),
    );
  }

  private async sendToRecipients(
    message: ChatMessageDto,
    recipients: string[],
    payload: ExpoPushPayload,
    badges: Map<string, number>,
    foregroundTokens: Map<string, Set<string>>,
    viewerPolicies: Map<string, SelfDestructPolicy>,
  ): Promise<void> {
    // 收件人的 token 一次查回、消息整批交给推送服务按 100 条一批发。原来是每个
    // 收件人各查一次 token、各发一次 HTTPS:3000 人的群一条消息就是 3000 + 3000 次。
    let tokensByUser: Map<
      string,
      Array<{ token: string; projectId: string | null }>
    >;
    try {
      tokensByUser = await this.push.listActiveTokensForUsers(recipients);
    } catch (error) {
      this.logFanoutFailure(
        message,
        recipients.length,
        recipients.length,
        error,
      );
      return;
    }
    const owners: string[] = [];
    const messages = recipients.flatMap((userId) => {
      const badge = badges.get(userId);
      const viewerBurnSeconds = this.viewerBurnSeconds(
        message,
        viewerPolicies.get(userId),
      );
      const privacyPayload =
        viewerBurnSeconds === null
          ? payload
          : {
              ...payload,
              body:
                payload.data['conversationType'] === 'private'
                  ? BURN_PREVIEW
                  : message.sender?.nickname
                    ? `${message.sender.nickname}: ${BURN_PREVIEW}`
                    : BURN_PREVIEW,
              ttl: Math.min(
                payload.ttl ?? CHAT_PUSH_TTL_SECONDS,
                viewerBurnSeconds,
              ),
            };
      const perUser =
        badge !== undefined ? { ...privacyPayload, badge } : privacyPayload;
      // 这台设备正开着 App:不推(消息已经实时送到它上面了)。
      const onScreen = foregroundTokens.get(userId);
      return (tokensByUser.get(userId) ?? [])
        .filter((token) => !onScreen?.has(token.token))
        .map((token) => {
          owners.push(userId);
          return { ...token, payload: perUser };
        });
    });
    if (messages.length === 0) return;
    const attempted = new Set(owners);

    let outcomes: TokenDeliveryOutcome[];
    try {
      outcomes = await this.push.sendMessages(messages);
    } catch (error) {
      this.logFanoutFailure(message, attempted.size, recipients.length, error);
      return;
    }
    // 结论与消息一一对应,失败按人数:一个人任何一台设备收下了就不算失败。
    // 不汇总的话,供应商整体故障时扇出静默蒸发,运维侧没有任何信号。
    const delivered = new Set<string>();
    let firstError: string | null = null;
    outcomes.forEach((outcome, index) => {
      if (outcome?.status === 'SENT') delivered.add(owners[index]);
      else firstError ??= outcome?.error ?? outcome?.status ?? 'unknown';
    });
    const failed = [...attempted].filter(
      (userId) => !delivered.has(userId),
    ).length;
    if (failed > 0) {
      this.logFanoutFailure(message, failed, recipients.length, firstError);
    }
  }

  /** 只记数量与首条原因,不逐条刷屏(3000 人的群失败就是 3000 行)。 */
  private logFanoutFailure(
    message: ChatMessageDto,
    failed: number,
    total: number,
    reason: unknown,
  ): void {
    const level = failed === total ? 'error' : 'warn';
    const firstError =
      reason instanceof Error ? reason.message : String(reason ?? 'unknown');
    this.logger[level](
      `chat push fanout: ${failed}/${total} recipients failed message=${message.id} firstError=${firstError}`,
    );
  }

  /**
   * G-06:一条查询捞全量座位(上限内),替掉 500/页的游标翻页 —— 3000 人群
   * 从 6 次往返降到 1 次。清空越过窗口里最新那条的人整个窗口都与他无关,
   * 直接在 SQL 里筛掉;发送者、在线、免打扰、已读按窗口内的具体消息另判。
   */
  private async listSeats(
    conversationId: string,
    latestHeight: number,
  ): Promise<PushSeat[]> {
    const seats = await this.prisma.chatMember.findMany({
      where: {
        conversationID: conversationId,
        leftAt: null,
        // Push previews carry message content and cannot rely on a client-side
        // watermark to discard a delayed delivery after history was cleared.
        clearedBeforeHeight: { lt: latestHeight },
      },
      select: { userID: true, muted: true },
      take: PUSH_TARGET_CAP,
    });
    if (seats.length >= PUSH_TARGET_CAP) {
      // 触顶记一条:静默截断会让「已推送全部成员」的假象留在日志里。
      this.logger.warn(
        `push seats hit the ${PUSH_TARGET_CAP} cap for conversation=${conversationId}; remainder skipped`,
      );
    }
    return seats;
  }

  /**
   * G-18:一条聚合查询算出这批收件人的全局未读总数(底数 = 已读与清空水位
   * 的更高者,不计自己发的、已删的、已撤回的)。口径与 app 内角标一致:免打扰
   * 会话不计 —— 否则每来一条推送,iOS 图标上的数字都比 app 里看得见的大。
   * 失败返回空 map,推送不带 badge。
   */
  private async loadUnreadBadges(
    userIds: string[],
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ userID: string; count: bigint }>
      >`
        SELECT cm."userID", COUNT(*)::bigint AS count
        FROM "ChatMember" cm
        JOIN "ChatMessage" m ON m."conversationID" = cm."conversationID"
        WHERE cm."userID" = ANY(${userIds}::text[])
          AND cm."leftAt" IS NULL
          -- 隐藏的会话不出现在 GET /chat/conversations 里,自然也不进 app 的
          -- tab 未读数。这里不排掉的话,任何一条别的会话的推送都会把 iOS 角标
          -- 顶到一个比 app 里看得见的总数更大的值,而且每来一条推送就复现一次。
          AND cm."hiddenAt" IS NULL
          AND cm."muted" = false
          AND m."deleted" = false
          AND m."revokedAt" IS NULL
          AND m."height" > GREATEST(cm."lastReadHeight", cm."clearedBeforeHeight")
          AND (m."senderID" IS NULL OR m."senderID" <> cm."userID")
        GROUP BY cm."userID"
      `;
      return new Map(rows.map((row) => [row.userID, Number(row.count)]));
    } catch (error) {
      this.logger.warn(
        `push badge aggregation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return new Map();
    }
  }

  private mentionedUserIds(message: ChatMessageDto): Set<string> {
    const raw = message.content['mentions'];
    if (!Array.isArray(raw)) return new Set();
    const ids = raw
      .map((entry) =>
        entry && typeof entry === 'object' && 'userId' in entry
          ? (entry as { userId?: unknown }).userId
          : undefined,
      )
      .filter((id): id is string => typeof id === 'string');
    return new Set(ids);
  }

  private async composePayload(
    message: ChatMessageDto,
    conversation: PushConversation,
  ): Promise<{ title: string; body: string; data: Record<string, unknown> }> {
    const senderName = message.sender?.nickname ?? '';
    const preview = this.previewFor(message);
    if (conversation.type === 'GROUP' && conversation.circleID) {
      const circle = await this.prisma.circle.findUnique({
        where: { id: conversation.circleID },
        select: { name: true },
      });
      const title = circle?.name ?? senderName;
      return {
        title,
        body: senderName ? `${senderName}: ${preview}` : preview,
        // 点按路由参数与聊天页入参对齐:GROUP 的 sourceID = 圈子 id。
        data: {
          type: 'chat',
          conversationId: message.conversationId,
          messageId: message.id,
          sourceID: conversation.circleID,
          conversationType: 'group',
          title,
        },
      };
    }
    if (conversation.type === 'TEMP') {
      const room = conversation.tempChatID
        ? await this.prisma.tempChat.findUnique({
            where: { id: conversation.tempChatID },
            select: { title: true },
          })
        : null;
      const title = room?.title ?? '临时群聊';
      return {
        title,
        body: senderName ? `${senderName}: ${preview}` : preview,
        data: {
          type: 'chat',
          conversationId: message.conversationId,
          messageId: message.id,
          sourceID: message.conversationId,
          conversationType: 'group',
          conversationKind: 'temp',
          title,
        },
      };
    }
    if (conversation.type === 'GROUP') {
      // 独立群聊:标题用群名(空群名退化到发送者);sourceID = 会话 id。
      const title = conversation.name?.trim() || senderName || '群聊';
      return {
        title,
        body: senderName ? `${senderName}: ${preview}` : preview,
        data: {
          type: 'chat',
          conversationId: message.conversationId,
          messageId: message.id,
          sourceID: message.conversationId,
          conversationType: 'group',
          title,
        },
      };
    }
    const title = senderName || '新消息';
    return {
      title,
      body: preview,
      // DIRECT:收件人视角的对端 = 发送者。
      data: {
        type: 'chat',
        conversationId: message.conversationId,
        // 撤回/焚毁/已读后前端据此收起这条通知。
        messageId: message.id,
        ...(message.sender ? { sourceID: message.sender.id } : {}),
        conversationType: 'private',
        title,
      },
    };
  }

  /** 推送预览:与前端 im.preview.* 同语义;服务端推送文案与既有推送同为中文。 */
  private previewFor(message: ChatMessageDto): string {
    if ((message.burnDurationSec ?? 0) > 0) return BURN_PREVIEW;
    switch (message.type) {
      case 'text':
      case 'quote': {
        const text = message.content['text'];
        const trimmed = typeof text === 'string' ? text : '';
        return trimmed.length > PREVIEW_MAX_LENGTH
          ? `${trimmed.slice(0, PREVIEW_MAX_LENGTH)}…`
          : trimmed || '[消息]';
      }
      case 'image':
        return '[图片]';
      case 'video':
        return '[视频]';
      case 'voice':
        return '[语音]';
      case 'file':
        return '[文件]';
      case 'location':
        return '[位置]';
      case 'transfer-card':
        return '[转账]';
      case 'note-card':
        return '[笔记]';
      case 'qr-card':
        return '[二维码]';
      default:
        return '[消息]';
    }
  }

  private viewerBurnSeconds(
    message: ChatMessageDto,
    policy: SelfDestructPolicy | undefined,
  ): number | null {
    if (!policy || policy.sec <= 0 || !policy.startedAt) return null;
    const createdAt = new Date(message.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt < policy.startedAt) {
      return null;
    }
    return policy.sec;
  }
}
