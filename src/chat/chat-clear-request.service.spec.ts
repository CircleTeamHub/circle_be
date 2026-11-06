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
  });

  describe('requestClear', () => {
    const directSeat = (overrides: Record<string, unknown> = {}) => ({
      leftAt: null,
      conversation: { type: 'DIRECT', nextHeight: 12 },
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

    it('never asks to clear beyond the current end of the conversation', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(directSeat());
      await service.requestClear('u1', 'conv-1', 999);
      expect(
        prisma.chatClearRequest.create.mock.calls[0][0].data.targetHeight,
      ).toBe(12);
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
  });
});
