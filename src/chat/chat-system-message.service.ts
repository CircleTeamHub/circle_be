import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import type { Prisma } from 'src/generated/prisma';
import { CHAT_ADVISORY_LOCK_NS, SYSTEM_MESSAGE_TYPE } from './chat.constants';
import { ChatBroadcastService } from './chat-broadcast.service';
import type { ChatMessageDto } from './chat.types';

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
  ) {}

  /** 落库(height 同一坐标系)并广播;失败只记日志(提示消息可丢)。 */
  async emit(
    conversationId: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CHAT_ADVISORY_LOCK_NS}, hashtext(${conversationId}))`;
        const maxHeight = await tx.chatMessage.aggregate({
          where: { conversationID: conversationId },
          _max: { height: true },
        });
        const created = await tx.chatMessage.create({
          data: {
            conversationID: conversationId,
            height: (maxHeight._max.height ?? 0) + 1,
            senderID: null,
            type: SYSTEM_MESSAGE_TYPE,
            content: content as Prisma.InputJsonObject,
            clientMessageId: null,
          },
        });
        await tx.chatConversation.update({
          where: { id: conversationId },
          data: { lastMessageAt: created.createdAt },
        });
        return created;
      });

      const dto: ChatMessageDto = {
        id: row.id,
        conversationId,
        height: row.height,
        type: SYSTEM_MESSAGE_TYPE,
        content,
        sender: null,
        replyToId: null,
        d: null,
        createdAt: row.createdAt.toISOString(),
      };
      this.broadcast.emitMessage(dto);
    } catch (error) {
      this.logger.warn(
        `system message emit failed conversation=${conversationId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
