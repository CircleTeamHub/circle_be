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
const PUSH_TARGET_CAP = 200;

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
      this.prisma.chatMember.findMany({
        where: {
          conversationID: message.conversationId,
          leftAt: null,
          ...(senderId ? { userID: { not: senderId } } : {}),
        },
        select: { userID: true, muted: true },
        take: PUSH_TARGET_CAP,
      }),
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
    await Promise.allSettled(
      targets.map(async (seat) => {
        const tokens = await this.push.listActiveTokens(seat.userID);
        if (tokens.length === 0) return;
        await this.push.sendToTokens(tokens, payload);
      }),
    );
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
      return {
        title: circle?.name ?? senderName,
        body: senderName ? `${senderName}: ${preview}` : preview,
        data: { type: 'chat', conversationId: message.conversationId },
      };
    }
    return {
      title: senderName || '新消息',
      body: preview,
      data: { type: 'chat', conversationId: message.conversationId },
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
