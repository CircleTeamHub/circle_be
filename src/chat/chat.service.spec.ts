import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { ChatService } from './chat.service';
import type { ChatSendPayload } from './chat.types';

describe('ChatService', () => {
  const prisma = {
    chatConversation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    chatMember: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    chatMessage: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      aggregate: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    user: { findUnique: jest.fn(), findMany: jest.fn() },
    circleMember: { findUnique: jest.fn() },
    circle: { findMany: jest.fn() },
    block: { findFirst: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
  };
  const sensitiveWords = { check: jest.fn() };
  const circleSync = { ensureCircleConversation: jest.fn() };
  const media = { attachMediaUrls: jest.fn().mockResolvedValue(undefined) };

  const service = new ChatService(
    prisma as never,
    sensitiveWords as never,
    circleSync as never,
    media as never,
  );

  // tx 即 prisma 本身,tx.* 委托到同一批 mock。
  const runTx = async (cb: (tx: typeof prisma) => unknown) => cb(prisma);

  const membership = (overrides: Record<string, unknown> = {}) => ({
    id: 'member-1',
    conversationID: 'conv-1',
    userID: 'u1',
    lastReadHeight: 0,
    pinned: false,
    muted: false,
    leftAt: null,
    conversation: {
      id: 'conv-1',
      type: 'GROUP',
      directKey: null,
      circleID: null,
      tempChatID: null,
      lastMessageAt: null,
    },
    ...overrides,
  });

  const sendPayload = (
    overrides: Partial<ChatSendPayload> = {},
  ): ChatSendPayload => ({
    conversationId: 'conv-1',
    type: 'text',
    content: { text: 'hello' },
    d: 'client-msg-1',
    ...overrides,
  });

  const createdRow = {
    id: 'msg-1',
    conversationID: 'conv-1',
    height: 4,
    senderID: 'u1',
    type: 'text',
    content: { text: 'hello' },
    clientMessageId: 'client-msg-1',
    replyToID: null,
    deleted: false,
    createdAt: new Date('2026-08-05T12:00:00Z'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(runTx as never);
    prisma.$executeRaw.mockResolvedValue(1);
    sensitiveWords.check.mockReturnValue({ blocked: false });
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', nickname: '一波', avatarUrl: null },
    ]);
    prisma.circle.findMany.mockResolvedValue([]);
  });

  describe('sendMessage', () => {
    it('persists with height = max + 1 and returns the dto', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(null);
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 3 } });
      prisma.chatMessage.create.mockResolvedValue(createdRow);
      prisma.chatConversation.update.mockResolvedValue({});

      const result = await service.sendMessage('u1', sendPayload());

      expect(result.reused).toBe(false);
      expect(result.message).toMatchObject({
        id: 'msg-1',
        conversationId: 'conv-1',
        height: 4,
        d: 'client-msg-1',
        sender: { id: 'u1', nickname: '一波' },
      });
      expect(prisma.chatMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            height: 4,
            clientMessageId: 'client-msg-1',
          }),
        }),
      );
      // 会话活跃时间在同一事务内推进(会话列表排序依据)。
      expect(prisma.chatConversation.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'conv-1' } }),
      );
      // height 分配必须发生在会话级咨询锁之内。
      expect(prisma.$executeRaw).toHaveBeenCalled();
    });

    it('returns the existing row on clientMessageId replay without re-persisting', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findUnique.mockResolvedValue(createdRow);

      const result = await service.sendMessage('u1', sendPayload());

      expect(result.reused).toBe(true);
      expect(result.message.id).toBe('msg-1');
      expect(prisma.chatMessage.create).not.toHaveBeenCalled();
      expect(prisma.chatConversation.update).not.toHaveBeenCalled();
    });

    it('rejects senders that are not members', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(service.sendMessage('u1', sendPayload())).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects members that already left', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({ leftAt: new Date() }),
      );
      await expect(service.sendMessage('u1', sendPayload())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('blocks sensitive words before any DB write', async () => {
      sensitiveWords.check.mockReturnValue({ blocked: true, word: 'bad' });
      await expect(
        service.sendMessage('u1', sendPayload()),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.SensitiveWord },
      });
      expect(prisma.chatMember.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects server-only message types from clients', async () => {
      await expect(
        service.sendMessage('u1', sendPayload({ type: 'system' })),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
    });

    it('rejects oversized content', async () => {
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({ content: { text: 'x'.repeat(9000) } }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('re-checks blocks on DIRECT sends', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(
        membership({
          conversation: {
            id: 'conv-1',
            type: 'DIRECT',
            directKey: 'u1:u2',
            circleID: null,
            tempChatID: null,
            lastMessageAt: null,
          },
        }),
      );
      prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(
        service.sendMessage('u1', sendPayload()),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.Blocked },
      });
    });
  });

  describe('markRead', () => {
    it('advances the watermark and reports advancement', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.markRead('u1', 'conv-1', 5)).resolves.toBe(true);
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
        where: {
          conversationID: 'conv-1',
          userID: 'u1',
          lastReadHeight: { lt: 5 },
        },
        data: { lastReadHeight: 5 },
      });
    });

    it('reports no advancement for stale watermarks (forward-only)', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markRead('u1', 'conv-1', 1)).resolves.toBe(false);
    });

    it('rejects non-integer heights', async () => {
      await expect(service.markRead('u1', 'conv-1', 1.5)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('getOrCreateDirectConversation', () => {
    const peer = {
      id: 'u2',
      nickname: '对方',
      avatarUrl: null,
      status: 'ACTIVE',
    };

    it('rejects self conversations', async () => {
      await expect(
        service.getOrCreateDirectConversation('u1', 'u1'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.SelfConversation },
      });
    });

    it('rejects missing or inactive peers', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toThrow(NotFoundException);
      prisma.user.findUnique.mockResolvedValue({ ...peer, status: 'BANNED' });
      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects blocked pairs in either direction', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue({ id: 'block-1' });
      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.Blocked },
      });
    });

    it('creates with a sorted directKey and both member rows', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.chatConversation.create.mockResolvedValue({
        id: 'conv-9',
        type: 'DIRECT',
        directKey: 'u1:u2',
        lastMessageAt: null,
        members: [
          {
            id: 'm1',
            userID: 'u1',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
          {
            id: 'm2',
            userID: 'u2',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
        ],
      });
      prisma.chatMessage.count.mockResolvedValue(0);

      const dto = await service.getOrCreateDirectConversation('u1', 'u2');

      expect(prisma.chatConversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ directKey: 'u1:u2' }),
        }),
      );
      expect(dto).toMatchObject({
        id: 'conv-9',
        type: 'DIRECT',
        peer: { id: 'u2' },
      });
    });

    it('recovers from a directKey unique race by refetching', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      const existing = {
        id: 'conv-9',
        type: 'DIRECT',
        directKey: 'u1:u2',
        lastMessageAt: null,
        members: [
          {
            id: 'm1',
            userID: 'u1',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
          {
            id: 'm2',
            userID: 'u2',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
        ],
      };
      prisma.chatConversation.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(existing);
      prisma.chatConversation.create.mockRejectedValue({ code: 'P2002' });
      prisma.chatMessage.count.mockResolvedValue(0);

      const dto = await service.getOrCreateDirectConversation('u1', 'u2');
      expect(dto.id).toBe('conv-9');
    });

    it('revives a membership the user previously left', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue({
        id: 'conv-9',
        type: 'DIRECT',
        directKey: 'u1:u2',
        lastMessageAt: null,
        members: [
          {
            id: 'm1',
            userID: 'u1',
            leftAt: new Date(),
            pinned: false,
            muted: false,
            lastReadHeight: 3,
          },
          {
            id: 'm2',
            userID: 'u2',
            leftAt: null,
            pinned: false,
            muted: false,
            lastReadHeight: 0,
          },
        ],
      });
      prisma.chatMember.update.mockResolvedValue({});
      prisma.chatMessage.count.mockResolvedValue(0);

      await service.getOrCreateDirectConversation('u1', 'u2');
      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: { id: 'm1' },
        data: { leftAt: null },
      });
    });
  });

  describe('getHistory', () => {
    it('pages by height keyset and returns ascending pages', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([
        { ...createdRow, id: 'msg-5', height: 5 },
        { ...createdRow, id: 'msg-4', height: 4 },
      ]);

      const page = await service.getHistory('u1', 'conv-1', 6, 2);

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ height: { lt: 6 }, deleted: false }),
          orderBy: { height: 'desc' },
          take: 2,
        }),
      );
      expect(page.messages.map((m) => m.height)).toEqual([4, 5]);
      // 满页 → 还有更早的,游标 = 页内最低 height。
      expect(page.nextBeforeHeight).toBe(4);
    });

    it('signals exhaustion with a null cursor on a short page', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([createdRow]);
      const page = await service.getHistory('u1', 'conv-1', undefined, 50);
      expect(page.nextBeforeHeight).toBeNull();
    });

    it('denies non-members', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(service.getHistory('u1', 'conv-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('listConversations', () => {
    it('returns dtos with unread counts excluding own messages', async () => {
      prisma.chatMember.findMany
        .mockResolvedValueOnce([
          {
            ...membership(),
            conversation: {
              id: 'conv-1',
              type: 'DIRECT',
              directKey: 'u1:u2',
              circleID: null,
              tempChatID: null,
              lastMessageAt: new Date('2026-08-05T12:00:00Z'),
            },
          },
        ])
        // loadDirectPeers 的对端成员查询。
        .mockResolvedValueOnce([{ conversationID: 'conv-1', userID: 'u2' }]);
      prisma.chatMessage.findFirst.mockResolvedValue(createdRow);
      prisma.chatMessage.count.mockResolvedValue(2);
      prisma.user.findMany.mockResolvedValue([
        { id: 'u1', nickname: '一波', avatarUrl: null },
        { id: 'u2', nickname: '对方', avatarUrl: null },
      ]);

      const list = await service.listConversations('u1');

      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id: 'conv-1',
        type: 'DIRECT',
        peer: { id: 'u2' },
        unreadCount: 2,
        lastMessage: { id: 'msg-1' },
      });
      expect(prisma.chatMessage.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ NOT: { senderID: 'u1' } }),
        }),
      );
    });
  });

  describe('getOrCreateCircleConversation', () => {
    it('rejects callers that are not ACTIVE circle members', async () => {
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'PENDING' });
      await expect(
        service.getOrCreateCircleConversation('u1', 'circle-1'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.NotMember },
      });
      expect(circleSync.ensureCircleConversation).not.toHaveBeenCalled();
    });

    it('syncs seats on access and returns the conversation dto', async () => {
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      circleSync.ensureCircleConversation.mockResolvedValue('conv-g');
      prisma.chatMember.findUnique.mockResolvedValue({
        ...membership(),
        conversationID: 'conv-g',
        conversation: {
          id: 'conv-g',
          type: 'GROUP',
          directKey: null,
          circleID: 'circle-1',
          tempChatID: null,
          lastMessageAt: null,
        },
      });
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      prisma.chatMessage.count.mockResolvedValue(0);

      const dto = await service.getOrCreateCircleConversation('u1', 'circle-1');

      expect(circleSync.ensureCircleConversation).toHaveBeenCalledWith(
        'circle-1',
      );
      expect(dto).toMatchObject({
        id: 'conv-g',
        type: 'GROUP',
        circleId: 'circle-1',
        unreadCount: 0,
      });
    });
  });

  describe('setConversationPreferences', () => {
    it('updates pinned/muted for the caller seat only', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMember.update.mockResolvedValue({});
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMember.findMany.mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);

      await service.setConversationPreferences('u1', 'conv-1', {
        pinned: true,
      });

      expect(prisma.chatMember.update).toHaveBeenCalledWith({
        where: {
          conversationID_userID: { conversationID: 'conv-1', userID: 'u1' },
        },
        data: { pinned: true },
      });
    });

    it('maps hidden boolean onto the hiddenAt timestamp', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMember.update.mockResolvedValue({});
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMember.findMany.mockResolvedValue([]);
      prisma.user.findMany.mockResolvedValue([]);

      await service.setConversationPreferences('u1', 'conv-1', {
        hidden: true,
      });
      expect(prisma.chatMember.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { hiddenAt: expect.any(Date) } }),
      );

      await service.setConversationPreferences('u1', 'conv-1', {
        hidden: false,
      });
      expect(prisma.chatMember.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { hiddenAt: null } }),
      );
    });
  });

  it('a new message unhides the conversation for every member', async () => {
    prisma.chatMember.findUnique.mockResolvedValue(membership());
    prisma.chatMessage.findUnique.mockResolvedValue(null);
    prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 3 } });
    prisma.chatMessage.create.mockResolvedValue(createdRow);
    prisma.chatConversation.update.mockResolvedValue({});
    prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });

    await service.sendMessage('u1', sendPayload());

    expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
      where: { conversationID: 'conv-1', hiddenAt: { not: null } },
      data: { hiddenAt: null },
    });
  });
});
