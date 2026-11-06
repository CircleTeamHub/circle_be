import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { PrismaService } from 'src/prisma/prisma.service';
import type { ChatMessageDto } from './chat.types';
import { ChatService } from './chat.service';
import { ChatSystemMessageService } from './chat-system-message.service';

/**
 * 私聊「申请双向清空」:申请人先把自己的记录清掉,再请对方授权;对方同意,服务端
 * 把对方的记录清到申请时的同一位置(之后的新消息不受影响),拒绝就只清了申请人自己的。
 * 申请和结果都是服务端签发的系统提示,客户端没法伪造一条「对方已同意」。
 */
@Injectable()
export class ChatClearRequestService {
  private readonly logger = new Logger(ChatClearRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chat: ChatService,
    private readonly systemMessage: ChatSystemMessageService,
  ) {}

  async requestClear(
    requesterId: string,
    conversationId: string,
    targetHeight: number,
  ): Promise<{ requestId: string }> {
    const seat = await this.prisma.chatMember.findUnique({
      where: {
        conversationID_userID: {
          conversationID: conversationId,
          userID: requesterId,
        },
      },
      include: {
        conversation: {
          select: { type: true, nextHeight: true, directKey: true },
        },
      },
    });
    if (!seat || seat.leftAt) {
      throw new ForbiddenException({
        message: '不是会话成员',
        errorCode: ChatErrorCode.NotMember,
      });
    }
    if (seat.conversation.type !== 'DIRECT') {
      throw new NotFoundException({
        message: '只有私聊可以申请双向清空',
        errorCode: ChatErrorCode.ConversationNotFound,
      });
    }
    // 拉黑不摘座位:被拉黑的一方不能再往对方会话里插申请提示。
    await this.chat.assertDirectMutationAllowed(seat.conversation, requesterId);
    const clearThrough = Math.min(
      Math.max(0, targetHeight),
      seat.conversation.nextHeight,
    );
    const { requestId, notice } = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ nextHeight: number }>>`
        SELECT "nextHeight" FROM "ChatConversation"
        WHERE "id" = ${conversationId} FOR UPDATE`;
      // 同一个人在这个会话里只保留一条待处理申请:重复点不会给对方刷一串提示。
      // 申请人后来又清到了更高处,就把这条申请的水位跟着推上去(只升不降),
      // 对方同意时清到的是申请人最后一次清到的位置。
      const pending = await tx.chatClearRequest.findFirst({
        where: {
          conversationID: conversationId,
          requesterID: requesterId,
          status: 'PENDING',
        },
        select: { id: true },
      });
      if (pending) {
        await tx.chatClearRequest.updateMany({
          where: { id: pending.id, targetHeight: { lt: clearThrough } },
          data: { targetHeight: clearThrough },
        });
        return { requestId: pending.id, notice: null };
      }
      const created = await tx.chatClearRequest.create({
        data: {
          conversationID: conversationId,
          requesterID: requesterId,
          targetHeight: clearThrough,
        },
        select: { id: true },
      });
      const message =
        await this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
          tx,
          conversationId,
          locked[0].nextHeight,
          {
            kind: 'clear-request',
            requestId: created.id,
            actorId: requesterId,
          },
        );
      return { requestId: created.id, notice: message };
    });
    if (notice) await this.broadcast(notice);
    return { requestId };
  }

  async respond(
    responderId: string,
    requestId: string,
    accept: boolean,
  ): Promise<{ accepted: boolean }> {
    const request = await this.prisma.chatClearRequest.findUnique({
      where: { id: requestId },
    });
    const seat = request
      ? await this.prisma.chatMember.findUnique({
          where: {
            conversationID_userID: {
              conversationID: request.conversationID,
              userID: responderId,
            },
          },
          select: { leftAt: true },
        })
      : null;
    // 申请人自己不能替对方「同意」;不在会话里的人看不到这条申请。
    if (
      !request ||
      request.requesterID === responderId ||
      !seat ||
      seat.leftAt
    ) {
      throw new NotFoundException({
        message: '申请不存在',
        errorCode: ChatErrorCode.MessageNotFound,
      });
    }
    // 已同意过、但当时清空那步失败了:同一个人再点「同意」就把清空补上(清到固定水位,
    // 重复执行没有副作用)。别的已处理情况照旧拒绝。
    if (request.status === 'ACCEPTED' && accept) {
      await this.chat.clearHistory(
        responderId,
        request.conversationID,
        false,
        request.targetHeight,
      );
      return { accepted: true };
    }
    const conversation = await this.prisma.chatConversation.findUnique({
      where: { id: request.conversationID },
      select: { type: true, directKey: true },
    });
    if (conversation)
      await this.chat.assertDirectMutationAllowed(conversation, responderId);
    const notice = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ nextHeight: number }>>`
        SELECT "nextHeight" FROM "ChatConversation"
        WHERE "id" = ${request.conversationID} FOR UPDATE`;
      // 条件更新:两台设备同时点,只有一台赢。
      const claimed = await tx.chatClearRequest.updateMany({
        where: { id: requestId, status: 'PENDING' },
        data: {
          status: accept ? 'ACCEPTED' : 'DECLINED',
          respondedAt: new Date(),
        },
      });
      if (claimed.count === 0) {
        throw new ConflictException({
          message: '这条申请已经处理过了',
          errorCode: ChatErrorCode.ClearRequestHandled,
        });
      }
      return this.systemMessage.insertSystemMessageAfterLockedConversationInTx(
        tx,
        request.conversationID,
        locked[0].nextHeight,
        {
          kind: 'clear-request-answered',
          requestId,
          accepted: accept,
          actorId: responderId,
        },
      );
    });
    await this.broadcast(notice);
    if (accept) {
      // 复用普通的「清空我的记录」:已读、焚毁计时、多端同步都按同一套走。
      await this.chat.clearHistory(
        responderId,
        request.conversationID,
        false,
        request.targetHeight,
      );
    }
    return { accepted: accept };
  }

  private async broadcast(notice: ChatMessageDto): Promise<void> {
    try {
      await this.systemMessage.broadcastSystemMessage(notice);
    } catch (error) {
      this.logger.warn(
        `clear request realtime delivery failed after commit (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
    }
  }
}
