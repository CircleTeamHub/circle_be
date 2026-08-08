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
/** 座位翻页大小。 */
const PUSH_SEAT_PAGE = 500;
/** 单批并发的推送数,给连接池和推送供应商留背压。 */
const PUSH_SEND_CONCURRENCY = 50;

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
    // 分批并发发送:扩容后的圈子可到 3000 人,一次性 allSettled 三千个
    // listActiveTokens 会把连接池和推送供应商同时打满。
    for (let i = 0; i < targets.length; i += PUSH_SEND_CONCURRENCY) {
      const batch = targets.slice(i, i + PUSH_SEND_CONCURRENCY);
      await Promise.allSettled(
        batch.map(async (seat) => {
          const tokens = await this.push.listActiveTokens(seat.userID);
          if (tokens.length === 0) return;
          await this.push.sendToTokens(tokens, payload);
        }),
      );
    }
  }

  /**
   * 会话内除发送者外的全部在座成员(游标翻页跑完)。
   * 原来是 take:200 且无排序:圈子扩容上限 3000,大群里绝大多数成员会被
   * 静默跳过 —— 而且每次跳过的都是同一批(无序 = 由计划器决定),
   * 那些人等于永久收不到新消息推送。
   */
  private async listSeats(
    conversationId: string,
    senderId: string | null,
  ): Promise<Array<{ userID: string; muted: boolean }>> {
    const seats: Array<{ userID: string; muted: boolean }> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.chatMember.findMany({
        where: {
          conversationID: conversationId,
          leftAt: null,
          ...(senderId ? { userID: { not: senderId } } : {}),
        },
        select: { id: true, userID: true, muted: true },
        orderBy: { id: 'asc' },
        take: PUSH_SEAT_PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      seats.push(...page.map((s) => ({ userID: s.userID, muted: s.muted })));
      if (page.length < PUSH_SEAT_PAGE) return seats;
      if (seats.length >= PUSH_TARGET_CAP) {
        // 触顶记一条:静默截断会让「已推送全部成员」的假象留在日志里。
        this.logger.warn(
          `push seats hit the ${PUSH_TARGET_CAP} cap for conversation=${conversationId}; remainder skipped`,
        );
        return seats;
      }
      cursor = page[page.length - 1].id;
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
    conversation: { type: string; circleID: string | null },
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
      default:
        return '[消息]';
    }
  }
}
