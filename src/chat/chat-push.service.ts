import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationPushService } from 'src/notification/notification-push.service';
import { ChatBroadcastService } from './chat-broadcast.service';
import type { ChatMessageDto } from './chat.types';

/**
 * 聊天离线推送(best-effort):socket 广播覆盖在线端,本服务只管离线成员。
 *
 * 刻意不走 NotificationPushOutbox —— 那条管道 1:1 挂在 Notification 行上,
 * 聊天消息若逐条建 Notification 会灌爆通知中心;而聊天推送天然可丢
 * (消息本体在库里,漏推 ≠ 丢消息),直发 + 失败记日志即可,
 * 与 squady 的 500ms 定时器分流同一取舍。
 *
 * 分流规则(微信式):发送者不推;在线成员不推;免打扰不推,
 * 但 @提及/@所有人 穿透免打扰。
 */
const PREVIEW_MAX_LENGTH = 60;
/**
 * 一条消息最多考虑多少个在座成员。圈子扩容上限 3000,留一倍余量;
 * 这是失控兜底而不是常规截断 —— 触顶会打 warn。
 */
const PUSH_TARGET_CAP = 6000;
/** 单批并发的推送数,给连接池和推送供应商留背压。 */
const PUSH_SEND_CONCURRENCY = 50;
/** 附带 badge 的最大扇出规模:超过则跳过逐人未读聚合(照常推送,只是无数字)。 */
const BADGE_TARGETS_MAX = 200;

@Injectable()
export class ChatPushService {
  private readonly logger = new Logger(ChatPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: NotificationPushService,
    private readonly broadcast: ChatBroadcastService,
  ) {}

  /** 网关在 socket 广播后 fire-and-forget 调用;任何失败只记日志。 */
  async onMessageBroadcast(message: ChatMessageDto): Promise<void> {
    try {
      await this.dispatch(message);
    } catch (error) {
      this.logger.warn(
        `chat push dispatch failed message=${message.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async dispatch(message: ChatMessageDto): Promise<void> {
    const senderId = message.sender?.id ?? null;
    const [seats, conversation, onlineIds] = await Promise.all([
      this.listSeats(message.conversationId, senderId),
      this.prisma.chatConversation.findUnique({
        where: { id: message.conversationId },
        select: {
          type: true,
          circleID: true,
          name: true,
        },
      }),
      this.broadcast.getOnlineUserIdsInConversation(message.conversationId),
    ]);
    if (!conversation || seats.length === 0) return;

    const mentioned = this.mentionedUserIds(message);
    const atAll = message.content['atAll'] === true;
    const targets = seats.filter((seat) => {
      if (onlineIds.has(seat.userID)) return false;
      if (!seat.muted) return true;
      // 免打扰穿透:被 @ 或 @所有人。
      return atAll || mentioned.has(seat.userID);
    });
    if (targets.length === 0) return;

    const payload = await this.composePayload(message, conversation);
    // G-18:小规模扇出附 per-recipient 角标(iOS 杀后台也有数字)。大群跳过 ——
    // 逐人聚合未读的代价与收益不成比;拿不到就不带 badge,推送照发。
    const badges =
      targets.length <= BADGE_TARGETS_MAX
        ? await this.loadUnreadBadges(targets.map((t) => t.userID))
        : new Map<string, number>();
    // 分批并发发送:扩容后的圈子可到 3000 人,一次性 allSettled 三千个
    // listActiveTokens 会把连接池和推送供应商同时打满。
    let failed = 0;
    let firstError: string | null = null;
    for (let i = 0; i < targets.length; i += PUSH_SEND_CONCURRENCY) {
      const batch = targets.slice(i, i + PUSH_SEND_CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(async (seat) => {
          const tokens = await this.push.listActiveTokens(seat.userID);
          if (tokens.length === 0) return;
          const badge = badges.get(seat.userID);
          await this.push.sendToTokens(
            tokens,
            badge !== undefined ? { ...payload, badge } : payload,
          );
        }),
      );
      // allSettled 会把每个收件人的失败原样吞掉:不看返回值的话,供应商或数据库
      // 整体故障时这里照样"成功"返回,外层的失败日志一次都不会触发 —— 整场扇出
      // 静默蒸发,而运维侧没有任何信号。逐批统计,最后汇总一条。
      for (const outcome of settled) {
        if (outcome.status !== 'rejected') continue;
        failed += 1;
        firstError ??=
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
      }
    }
    if (failed > 0) {
      // 只记数量与首条原因,不逐条刷屏(3000 人的群失败就是 3000 行)。
      const level = failed === targets.length ? 'error' : 'warn';
      this.logger[level](
        `chat push fanout: ${failed}/${targets.length} recipients failed message=${message.id} firstError=${firstError}`,
      );
    }
  }

  /**
   * G-06:一条查询捞全量座位(上限内),替掉 500/页的游标翻页 —— 3000 人群
   * 从 6 次往返降到 1 次。在线/免打扰的过滤仍在内存做(在线集合来自
   * Redis 注册表,免打扰要给 @提及穿透留口子)。
   */
  private async listSeats(
    conversationId: string,
    senderId: string | null,
  ): Promise<Array<{ userID: string; muted: boolean }>> {
    const seats = await this.prisma.chatMember.findMany({
      where: {
        conversationID: conversationId,
        leftAt: null,
        ...(senderId ? { userID: { not: senderId } } : {}),
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
   * 的更高者,不计自己发的、不计已删)。失败返回空 map,推送不带 badge。
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
          AND m."deleted" = false
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
    conversation: {
      type: string;
      circleID: string | null;
      name: string | null;
    },
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
          sourceID: conversation.circleID,
          conversationType: 'group',
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
        ...(message.sender ? { sourceID: message.sender.id } : {}),
        conversationType: 'private',
        title,
      },
    };
  }

  /** 推送预览:与前端 im.preview.* 同语义;服务端推送文案与既有推送同为中文。 */
  private previewFor(message: ChatMessageDto): string {
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
}
