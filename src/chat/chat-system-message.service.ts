import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import type { Prisma } from 'src/generated/prisma';
import { SYSTEM_MESSAGE_TYPE } from './chat.constants';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatPushService } from './chat-push.service';
import type { ChatMessageDto, ChatSenderInfo } from './chat.types';

export interface ServerMessageInput {
  /** 发送者 userID;系统提示传 null。 */
  senderID: string | null;
  type: string;
  content: Record<string, unknown>;
  /** 幂等键(需 senderID 非空才参与唯一约束):补偿重试不写第二条。 */
  clientMessageId?: string;
  /** 是否走离线推送分流(默认 false:群留痕类不推)。 */
  push?: boolean;
}

/**
 * 系统消息(进群/退群提示等):senderID 为 null,type='system',
 * content 只存结构化 {kind, ...params},本地化在前端按 im.notification.* 词表做
 * (服务端不知道收端语言)。
 *
 * 独立成服务而非塞进 ChatService:ChatCircleSyncService 需要发系统消息,
 * 而 ChatService 已依赖 sync(getOrCreateCircleConversation)—— 拆开断环。
 */
@Injectable()
export class ChatSystemMessageService {
  private readonly logger = new Logger(ChatSystemMessageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly broadcast: ChatBroadcastService,
    private readonly chatPush: ChatPushService,
  ) {}

  /**
   * 服务端产消息的统一原语(通话留痕/转账卡补发/好友申请回放共用):
   * height 同一坐标系落库(幂等键撞库即复用,不重广播)→ 广播 → 可选推送。
   * 抛错交调用方(补偿类调用方自带重试);系统提示请用 emit(不抛)。
   */
  async insertServerMessage(
    conversationId: string,
    input: ServerMessageInput,
  ): Promise<ChatMessageDto> {
    const { row, reused } = await this.prisma.$transaction(async (tx) => {
      // G-05:与客户端发送同一把行锁、同一个计数器(两条发号路径必须一致,
      // 否则并发下撞 (conversationID, height) 唯一约束)。
      const counter = await tx.$queryRaw<Array<{ nextHeight: number }>>`
        SELECT "nextHeight" FROM "ChatConversation"
        WHERE "id" = ${conversationId} FOR UPDATE`;
      if (counter.length === 0) {
        throw new Error(`conversation ${conversationId} not found`);
      }
      if (input.clientMessageId && input.senderID) {
        const existing = await tx.chatMessage.findUnique({
          where: {
            conversationID_senderID_clientMessageId: {
              conversationID: conversationId,
              senderID: input.senderID,
              clientMessageId: input.clientMessageId,
            },
          },
        });
        if (existing) return { row: existing, reused: true };
      }
      const height = counter[0].nextHeight + 1;
      const row = await tx.chatMessage.create({
        data: {
          conversationID: conversationId,
          height,
          senderID: input.senderID,
          type: input.type,
          content: input.content as Prisma.InputJsonObject,
          clientMessageId:
            input.senderID && input.clientMessageId
              ? input.clientMessageId
              : null,
        },
      });
      await tx.chatConversation.update({
        where: { id: conversationId },
        data: { nextHeight: height, lastMessageAt: row.createdAt },
      });
      await tx.chatMember.updateMany({
        where: { conversationID: conversationId, hiddenAt: { not: null } },
        data: { hiddenAt: null },
      });
      return { row, reused: false };
    });

    const sender = input.senderID
      ? await this.resolveSender(input.senderID)
      : null;
    const dto: ChatMessageDto = {
      id: row.id,
      conversationId,
      height: row.height,
      type: row.type,
      content: input.content,
      sender,
      replyToId: null,
      d: row.clientMessageId,
      createdAt: row.createdAt.toISOString(),
    };
    if (!reused) {
      this.broadcast.emitMessage(dto);
      if (input.push) void this.chatPush.onMessageBroadcast(dto);
    }
    return dto;
  }

  private async resolveSender(userId: string): Promise<ChatSenderInfo | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, nickname: true, avatarUrl: true },
    });
    return user
      ? { id: user.id, nickname: user.nickname, avatarUrl: user.avatarUrl }
      : null;
  }

  /**
   * 在**调用方的事务里**落一条系统消息,返回可广播的 DTO。
   *
   * 给「设置变更必须留痕」这类场景用:调用方把设置更新和这条提示放进同一个
   * 事务,要么都成、要么都不成。提交之后再拿返回值调 broadcastSystemMessage。
   */
  async insertSystemMessageInTx(
    tx: Prisma.TransactionClient,
    conversationId: string,
    content: Record<string, unknown>,
  ): Promise<ChatMessageDto> {
    const counter = await tx.$queryRaw<Array<{ nextHeight: number }>>`
      SELECT "nextHeight" FROM "ChatConversation"
      WHERE "id" = ${conversationId} FOR UPDATE`;
    if (counter.length === 0) {
      throw new Error(`conversation ${conversationId} not found`);
    }
    const height = counter[0].nextHeight + 1;
    const created = await tx.chatMessage.create({
      data: {
        conversationID: conversationId,
        height,
        senderID: null,
        type: SYSTEM_MESSAGE_TYPE,
        content: content as Prisma.InputJsonObject,
        clientMessageId: null,
      },
    });
    await tx.chatConversation.update({
      where: { id: conversationId },
      data: { nextHeight: height, lastMessageAt: created.createdAt },
    });
    // 新消息让隐藏的会话重新浮出 —— 与客户端发送、insertServerMessage 同一
    // 语义(微信式)。漏掉这一步的话:用户 swipe 隐藏了群,之后的进/退群提示
    // 照常落库并计入未读,但会话本身不回到 GET /chat/conversations 里,
    // 表现为"有未读却找不到会话"。
    await tx.chatMember.updateMany({
      where: { conversationID: conversationId, hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
    return {
      id: created.id,
      conversationId,
      height: created.height,
      type: SYSTEM_MESSAGE_TYPE,
      content,
      sender: null,
      replyToId: null,
      d: null,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /** 事务提交之后再播,别在事务里播(回滚了消息却已经发出去)。 */
  broadcastSystemMessage(dto: ChatMessageDto): void {
    this.broadcast.emitMessage(dto);
  }

  /** 落库(height 同一坐标系)并广播;失败只记日志(提示消息可丢)。 */
  async emit(
    conversationId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    try {
      const dto = await this.prisma.$transaction((tx) =>
        this.insertSystemMessageInTx(tx, conversationId, content),
      );
      this.broadcastSystemMessage(dto);
    } catch (error) {
      this.logger.warn(
        `system message emit failed conversation=${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
