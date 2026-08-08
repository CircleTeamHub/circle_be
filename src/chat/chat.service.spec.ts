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
    friend: { findFirst: jest.fn() },
    $transaction: jest.fn(),
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
  };
  const sensitiveWords = { check: jest.fn() };
  const circleSync = { ensureCircleConversation: jest.fn() };
  const media = { attachMediaUrls: jest.fn().mockResolvedValue(undefined) };
  const privacySettings = {
    canReceiveStrangerMessage: jest.fn().mockResolvedValue(true),
  };
  const broadcast = {
    joinUserToConversation: jest.fn().mockResolvedValue(undefined),
  };

  const service = new ChatService(
    prisma as never,
    sensitiveWords as never,
    circleSync as never,
    media as never,
    privacySettings as never,
    broadcast as never,
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
    // loadLastMessages / loadUnreadCounts 现在是集合查询,默认「无行」。
    prisma.$queryRaw.mockResolvedValue([]);
    privacySettings.canReceiveStrangerMessage.mockResolvedValue(true);
    broadcast.joinUserToConversation.mockResolvedValue(undefined);
    prisma.friend.findFirst.mockResolvedValue(null);
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

    it('rejects media payloads that carry URLs instead of object keys', async () => {
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({
            type: 'image',
            content: { key: 'https://evil.example/a.jpg' },
          }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({ type: 'voice', content: { duration: 3 } }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
    });

    it("rejects media keys outside the sender's own chat namespace", async () => {
      // 从早期授权响应里学到的别人的私有 key,不能借聊天读路径无限续签。
      for (const key of [
        'notes/u2/private.jpg',
        'chat/u2/other.jpg',
        'chat/u1',
        'chat/u1/../notes/u2/private.jpg',
      ]) {
        await expect(
          service.sendMessage(
            'u1',
            sendPayload({ type: 'image', content: { key } }),
          ),
        ).rejects.toMatchObject({
          response: { errorCode: ChatErrorCode.InvalidPayload },
        });
      }
      // thumbKey 同样收口。
      await expect(
        service.sendMessage(
          'u1',
          sendPayload({
            type: 'image',
            content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u2/t.jpg' },
          }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.InvalidPayload },
      });
    });

    it("accepts a media key inside the sender's own namespace", () => {
      expect(() =>
        service.validateSendPayload(
          'u1',
          sendPayload({
            type: 'image',
            content: { key: 'chat/u1/a.jpg', thumbKey: 'chat/u1/t.jpg' },
          }),
        ),
      ).not.toThrow();
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
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });
      await expect(service.markRead('u1', 'conv-1', 5)).resolves.toEqual({
        advanced: true,
        height: 5,
      });
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
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.markRead('u1', 'conv-1', 1)).resolves.toEqual({
        advanced: false,
        height: 1,
      });
    });

    it('clamps a future watermark to the conversation height', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({ _max: { height: 9 } });
      prisma.chatMember.updateMany.mockResolvedValue({ count: 1 });

      // height=2e9 未钳位的话会永久压掉后续所有未读,并广播一条假已读。
      await expect(
        service.markRead('u1', 'conv-1', 2_000_000_000),
      ).resolves.toEqual({ advanced: true, height: 9 });
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { lastReadHeight: 9 } }),
      );
    });

    it('is a no-op on an empty conversation', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.aggregate.mockResolvedValue({
        _max: { height: null },
      });
      await expect(service.markRead('u1', 'conv-1', 5)).resolves.toEqual({
        advanced: false,
        height: 0,
      });
      expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
    });

    it('rejects non-integer heights', async () => {
      await expect(service.markRead('u1', 'conv-1', 1.5)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('filterVisiblePresenceTargets', () => {
    it('drops users that share no conversation with the requester', async () => {
      prisma.chatMember.findMany
        // listConversationIds
        .mockResolvedValueOnce([{ conversationID: 'conv-1' }])
        // 共处会话的目标
        .mockResolvedValueOnce([{ userID: 'u2' }]);

      await expect(
        service.filterVisiblePresenceTargets('u1', ['u2', 'stranger']),
      ).resolves.toEqual(['u2']);
    });

    it('always allows the requester itself and short-circuits', async () => {
      await expect(
        service.filterVisiblePresenceTargets('u1', ['u1']),
      ).resolves.toEqual(['u1']);
      expect(prisma.chatMember.findMany).not.toHaveBeenCalled();
    });

    it('returns nothing when the requester has no conversations', async () => {
      prisma.chatMember.findMany.mockResolvedValueOnce([]);
      await expect(
        service.filterVisiblePresenceTargets('u1', ['u2']),
      ).resolves.toEqual([]);
    });
  });

  describe('getOrCreateDirectConversation', () => {
    const peer = {
      id: 'u2',
      nickname: '对方',
      avatarUrl: null,
      status: 'ACTIVE',
    };
    const conversationRow = {
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

    it('refuses to open a chat with a stranger who disallows stranger messages', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.friend.findFirst.mockResolvedValue(null);
      privacySettings.canReceiveStrangerMessage.mockResolvedValue(false);

      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.StrangerNotAllowed },
      });
      // 只查拉黑放行的话,这里已经建好会话并可以立刻 socket 发消息了。
      expect(prisma.chatConversation.create).not.toHaveBeenCalled();
    });

    it('lets accepted friends through regardless of the stranger switch', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.friend.findFirst.mockResolvedValue({ id: 'f1' });
      prisma.chatConversation.create.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);

      await service.getOrCreateDirectConversation('u1', 'u2');
      expect(privacySettings.canReceiveStrangerMessage).toHaveBeenCalledWith(
        'u2',
        true,
      );
    });

    it('does not re-check the switch for an existing conversation', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);

      await service.getOrCreateDirectConversation('u1', 'u2');
      // 事后关掉开关不该把既有会话锁死。
      expect(privacySettings.canReceiveStrangerMessage).not.toHaveBeenCalled();
    });

    it("joins both members' live sockets to the conversation room", async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      prisma.chatConversation.create.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);

      await service.getOrCreateDirectConversation('u1', 'u2');
      // 不 join 的话首条消息的房广播会漏掉在线的对端,推送还会误判他离线。
      expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
        'u1',
        'conv-9',
      );
      expect(broadcast.joinUserToConversation).toHaveBeenCalledWith(
        'u2',
        'conv-9',
      );
    });

    it('still returns the conversation when joining a room fails', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue(null);
      broadcast.joinUserToConversation.mockRejectedValue(
        new Error('no server'),
      );

      await expect(
        service.getOrCreateDirectConversation('u1', 'u2'),
      ).resolves.toMatchObject({ id: 'conv-9' });
    });

    it('returns the real last message for an existing conversation', async () => {
      prisma.user.findUnique.mockResolvedValue(peer);
      prisma.block.findFirst.mockResolvedValue(null);
      prisma.chatConversation.findUnique.mockResolvedValue(conversationRow);
      prisma.chatMessage.count.mockResolvedValue(0);
      prisma.chatMessage.findFirst.mockResolvedValue({
        id: 'msg-7',
        conversationID: 'conv-9',
        height: 7,
        senderID: 'u1',
        type: 'text',
        content: { text: '在吗' },
        clientMessageId: 'd-7',
        replyToID: null,
        deleted: false,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      });

      const dto = await service.getOrCreateDirectConversation('u1', 'u2');
      // 恒 null 会把客户端缓存里的会话预览抹成空白。
      expect(dto.lastMessage).toMatchObject({ id: 'msg-7', height: 7 });
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

    it('applies type/keyword/date filters onto the where clause', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([]);

      // 东八区(getTimezoneOffset = -480)的 2026-08-05:UTC 前一日 16:00 起算。
      await service.getHistory('u1', 'conv-1', undefined, 50, {
        types: ['image'],
        keyword: '合同',
        date: '2026-08-05',
        tzOffsetMinutes: -480,
      });

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            type: { in: ['image'] },
            content: { path: ['text'], string_contains: '合同' },
            createdAt: {
              gte: new Date('2026-08-04T16:00:00.000Z'),
              lt: new Date('2026-08-05T16:00:00.000Z'),
            },
          }),
        }),
      );
    });

    it('denies non-members', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(service.getHistory('u1', 'conv-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('listMessageDays', () => {
    it('groups message timestamps into client-timezone days', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(membership());
      prisma.chatMessage.findMany.mockResolvedValue([
        // UTC 8/4 17:00 = 东八区 8/5 01:00;UTC 8/5 15:00 = 东八区 8/5 23:00。
        { createdAt: new Date('2026-08-04T17:00:00.000Z') },
        { createdAt: new Date('2026-08-05T15:00:00.000Z') },
        { createdAt: new Date('2026-08-05T17:00:00.000Z') }, // 东八区 8/6
      ]);

      const days = await service.listMessageDays('u1', 'conv-1', 2026, 7, -480);
      expect(days).toEqual(['2026-08-05', '2026-08-06']);
    });

    it('denies non-members', async () => {
      prisma.chatMember.findUnique.mockResolvedValue(null);
      await expect(
        service.listMessageDays('u1', 'conv-1', 2026, 7, 0),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('searchAllMessages', () => {
    it('returns empty for blank keywords without querying', async () => {
      await expect(service.searchAllMessages('u1', '  ')).resolves.toEqual([]);
      expect(prisma.chatMessage.findMany).not.toHaveBeenCalled();
    });

    it('scopes the search to conversations the user is seated in', async () => {
      prisma.chatMember.findMany.mockResolvedValue([
        { conversationID: 'conv-1' },
        { conversationID: 'conv-2' },
      ]);
      prisma.chatMessage.findMany.mockResolvedValue([createdRow]);

      const rows = await service.searchAllMessages('u1', 'hello');

      expect(prisma.chatMessage.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            conversationID: { in: ['conv-1', 'conv-2'] },
            type: { in: ['text', 'quote'] },
            content: { path: ['text'], string_contains: 'hello' },
          }),
          orderBy: { createdAt: 'desc' },
        }),
      );
      expect(rows).toHaveLength(1);
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
      // 末条消息与未读数各一次集合查询(不再每会话一次往返)。
      prisma.$queryRaw
        .mockResolvedValueOnce([createdRow])
        .mockResolvedValueOnce([
          { conversationID: 'conv-1', count: BigInt(2) },
        ]);
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
    });

    it('keeps the query count flat as the conversation list grows', async () => {
      const rows = Array.from({ length: 60 }, (_, i) => ({
        ...membership(),
        conversationID: `conv-${i}`,
        conversation: {
          id: `conv-${i}`,
          type: 'GROUP',
          directKey: null,
          circleID: null,
          tempChatID: null,
          lastMessageAt: new Date('2026-08-05T12:00:00Z'),
        },
      }));
      prisma.chatMember.findMany.mockResolvedValueOnce(rows);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.listConversations('u1');

      // 60 个会话 → 2 次集合查询(末条 + 未读),而不是 120 次往返。
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.chatMessage.findFirst).not.toHaveBeenCalled();
      expect(prisma.chatMessage.count).not.toHaveBeenCalled();
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
