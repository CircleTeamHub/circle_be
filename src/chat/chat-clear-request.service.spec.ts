import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatClearRequestService } from './chat-clear-request.service';

describe('ChatClearRequestService', () => {
  const prisma = {
    chatMember: { findUnique: jest.fn() },
    chatConversation: { findUnique: jest.fn() },
    chatClearRequest: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const chat = {
    clearHistory: jest.fn().mockResolvedValue({ clearedBeforeHeight: 7 }),
    assertDirectMutationAllowed: jest.fn(),
  };
  const systemMessage = {
    insertSystemMessageAfterLockedConversationInTx: jest
      .fn()
      .mockImplementation(
        async (
          _tx: unknown,
          conversationId: string,
          height: number,
          content: unknown,
        ) => ({
          id: `notice-${height + 1}`,
          conversationId,
          height: height + 1,
          content,
        }),
      ),
    broadcastSystemMessage: jest.fn().mockResolvedValue(undefined),
  };
  const service = new ChatClearRequestService(
    prisma as never,
    chat as never,
    systemMessage as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (cb: (tx: typeof prisma) => unknown) => cb(prisma),
    );
    prisma.$queryRaw.mockResolvedValue([{ nextHeight: 12 }]);
    prisma.chatClearRequest.create.mockResolvedValue({ id: 'req-1' });
    prisma.chatClearRequest.findFirst.mockResolvedValue(null);
    prisma.chatClearRequest.updateMany.mockResolvedValue({ count: 1 });
    prisma.chatConversation.findUnique.mockResolvedValue({
      type: 'DIRECT',
      directKey: 'u1:u2',
    });
    chat.assertDirectMutationAllowed.mockResolvedValue(undefined);
  });

  const blocked = () =>
    new ForbiddenException({
      message: '对方不可用',
      errorCode: ChatErrorCode.Blocked,
    });

  describe('requestClear', () => {
    const directSeat = (overrides: Record<string, unknown> = {}) => ({
      leftAt: null,
      clearedBeforeHeight: 10,
      conversation: { type: 'DIRECT', nextHeight: 12, directKey: 'u1:u2' },
      ...overrides,
    });

    it('records the request at the requested height and tells the other side', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(directSeat());
      await expect(service.requestClear('u1', 'conv-1', 10)).resolves.toEqual({
        requestId: 'req-1',
      });
      expect(prisma.chatClearRequest.create).toHaveBeenCalledWith({
        data: { conversationID: 'conv-1', requesterID: 'u1', targetHeight: 10 },
        select: { id: true },
      });
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 12, {
        kind: 'clear-request',
        requestId: 'req-1',
        actorId: 'u1',
      });
      expect(systemMessage.broadcastSystemMessage).toHaveBeenCalled();
    });

    it('uses the requester server-side clear watermark instead of a client-claimed height', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        directSeat({ clearedBeforeHeight: 7 }),
      );
      await service.requestClear('u1', 'conv-1', 999);
      expect(
        prisma.chatClearRequest.create.mock.calls[0][0].data.targetHeight,
      ).toBe(7);
    });

    it('asking again while a request is pending reuses it instead of notifying again', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(directSeat());
      prisma.chatClearRequest.findFirst.mockResolvedValue({ id: 'req-old' });
      await expect(service.requestClear('u1', 'conv-1', 10)).resolves.toEqual({
        requestId: 'req-old',
      });
      expect(prisma.chatClearRequest.create).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
    });

    // 申请人后来又清到了更高处:对方同意时要清到最后那次的位置,而不是第一次的。
    it('raises a pending request to the newer height, never lowers it', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        directSeat({ clearedBeforeHeight: 11 }),
      );
      prisma.chatClearRequest.findFirst.mockResolvedValue({ id: 'req-old' });
      await service.requestClear('u1', 'conv-1', 11);
      expect(prisma.chatClearRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'req-old', targetHeight: { lt: 11 } },
        data: { targetHeight: 11 },
      });
    });

    // 拉黑不摘座位:被拉黑的一方不能再往对方会话里插申请提示。
    it('refuses a request between blocked users before writing anything', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(directSeat());
      chat.assertDirectMutationAllowed.mockRejectedValue(blocked());
      await expect(
        service.requestClear('u1', 'conv-1', 10),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.Blocked },
      });
      expect(chat.assertDirectMutationAllowed).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'DIRECT', directKey: 'u1:u2' }),
        'u1',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).not.toHaveBeenCalled();
    });

    it('is only for private chats', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        directSeat({ conversation: { type: 'GROUP', nextHeight: 12 } }),
      );
      await expect(
        service.requestClear('u1', 'conv-1', 10),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.chatClearRequest.create).not.toHaveBeenCalled();
    });

    it('refuses someone outside the conversation', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(
        service.requestClear('u1', 'conv-1', 10),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('respond', () => {
    const request = {
      id: 'req-1',
      conversationID: 'conv-1',
      requesterID: 'u1',
      targetHeight: 10,
      status: 'PENDING',
    };

    it('accepting clears the responder up to the requested height and announces it', async () => {
      prisma.chatClearRequest.findUnique.mockResolvedValue(request);
      prisma.chatMember.findUnique.mockResolvedValue({ leftAt: null });
      await expect(service.respond('u2', 'req-1', true)).resolves.toEqual({
        accepted: true,
      });
      expect(prisma.chatClearRequest.updateMany).toHaveBeenCalledWith({
        where: { id: 'req-1', status: 'PENDING' },
        data: expect.objectContaining({ status: 'ACCEPTED' }),
      });
      expect(chat.clearHistory).toHaveBeenCalledWith('u2', 'conv-1', false, 10);
      expect(
        systemMessage.insertSystemMessageAfterLockedConversationInTx,
      ).toHaveBeenCalledWith(prisma, 'conv-1', 12, {
        kind: 'clear-request-answered',
        requestId: 'req-1',
        accepted: true,
        actorId: 'u2',
      });
    });

    it('declining clears nothing on the responder side', async () => {
      prisma.chatClearRequest.findUnique.mockResolvedValue(request);
      prisma.chatMember.findUnique.mockResolvedValue({ leftAt: null });
      await service.respond('u2', 'req-1', false);
      expect(chat.clearHistory).not.toHaveBeenCalled();
      expect(
        prisma.chatClearRequest.updateMany.mock.calls[0][0].data.status,
      ).toBe('DECLINED');
    });

    it('the requester cannot answer their own request', async () => {
      prisma.chatClearRequest.findUnique.mockResolvedValue(request);
      prisma.chatMember.findUnique.mockResolvedValue({ leftAt: null });
      await expect(service.respond('u1', 'req-1', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(chat.clearHistory).not.toHaveBeenCalled();
    });

    it('a request already answered on another device is rejected and clears nothing', async () => {
      prisma.chatClearRequest.findUnique.mockResolvedValue(request);
      prisma.chatMember.findUnique.mockResolvedValue({ leftAt: null });
      prisma.chatClearRequest.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.respond('u2', 'req-1', true)).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.ClearRequestHandled },
      });
      await expect(service.respond('u2', 'req-1', true)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(chat.clearHistory).not.toHaveBeenCalled();
    });

    it('agreeing again finishes a clear that failed after the acceptance was saved', async () => {
      prisma.chatClearRequest.findUnique.mockResolvedValue({
        ...request,
        status: 'ACCEPTED',
      });
      prisma.chatMember.findUnique.mockResolvedValue({ leftAt: null });
      await expect(service.respond('u2', 'req-1', true)).resolves.toEqual({
        accepted: true,
      });
      expect(chat.clearHistory).toHaveBeenCalledWith('u2', 'conv-1', false, 10);
      expect(prisma.chatClearRequest.updateMany).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
    });

    it('someone who left the chat cannot answer', async () => {
      prisma.chatClearRequest.findUnique.mockResolvedValue(request);
      prisma.chatMember.findUnique.mockResolvedValue({ leftAt: new Date() });
      await expect(service.respond('u2', 'req-1', true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a blocked pair cannot answer, and nothing is claimed or announced', async () => {
      prisma.chatClearRequest.findUnique.mockResolvedValue(request);
      prisma.chatMember.findUnique.mockResolvedValue({ leftAt: null });
      chat.assertDirectMutationAllowed.mockRejectedValue(blocked());
      await expect(service.respond('u2', 'req-1', true)).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.Blocked },
      });
      expect(chat.assertDirectMutationAllowed).toHaveBeenCalledWith(
        { type: 'DIRECT', directKey: 'u1:u2' },
        'u2',
      );
      expect(prisma.chatClearRequest.updateMany).not.toHaveBeenCalled();
      expect(chat.clearHistory).not.toHaveBeenCalled();
      expect(systemMessage.broadcastSystemMessage).not.toHaveBeenCalled();
    });
  });
});
