import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
} from '@nestjs/common';
import { ChatErrorCode } from 'src/common/app-error-codes';
import { TempChatService } from './temp-chat.service';
import { TEMP_CHAT_HOST_ALIAS } from 'src/chat/chat-guest-view';

describe('TempChatService', () => {
  const prisma = {
    tempChat: {
      count: jest.fn(),
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    tempChatGuest: {
      count: jest.fn(),
      create: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    chatConversation: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    chatMember: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };
  const linkToken = {
    sign: jest.fn().mockReturnValue('link-token'),
    verify: jest.fn(),
    signGuest: jest.fn().mockReturnValue('guest-chat-token'),
  };
  const config = { get: jest.fn() };
  const chatBroadcast = {
    joinUserToConversation: jest.fn().mockResolvedValue(undefined),
    disconnectUser: jest.fn().mockResolvedValue(undefined),
    removeUserFromConversation: jest.fn().mockResolvedValue(undefined),
    emitConversationChange: jest.fn(),
  };
  const chatService = {
    listMembers: jest.fn().mockResolvedValue([]),
    getNoteCardNoteId: jest.fn(),
    getHistory: jest.fn(),
  };
  const noteService = {
    getSharedNoteForGuest: jest.fn(),
  };
  const sensitiveWords = {
    check: jest.fn().mockReturnValue({ blocked: false }),
  };

  const service = new TempChatService(
    prisma as never,
    linkToken as never,
    config as never,
    chatBroadcast as never,
    chatService as never,
    noteService as never,
    sensitiveWords as never,
  );

  const runTx = async (cb: (tx: typeof prisma) => unknown) => cb(prisma);
  const future = new Date(Date.now() + 60 * 60 * 1000);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(runTx as never);
    prisma.$queryRaw.mockResolvedValue(1);
    prisma.$executeRaw.mockResolvedValue(1);
    linkToken.sign.mockReturnValue('link-token');
    linkToken.signGuest.mockReturnValue('guest-chat-token');
    config.get.mockImplementation((key: string, fallback?: unknown) => {
      if (key === 'TEMP_CHAT_WEB_BASE') return 'https://t.example';
      return fallback;
    });
    chatBroadcast.joinUserToConversation.mockResolvedValue(undefined);
    chatBroadcast.disconnectUser.mockResolvedValue(undefined);
    chatBroadcast.removeUserFromConversation.mockResolvedValue(undefined);
    chatService.listMembers.mockResolvedValue([]);
    chatService.getNoteCardNoteId.mockResolvedValue('note-1');
    noteService.getSharedNoteForGuest.mockResolvedValue({ id: 'note-1' });
  });

  describe('getGuestNote', () => {
    const guest = {
      kind: 'temp-chat-guest' as const,
      guestId: 'guest-1',
      tcId: 'tc-1',
      conversationId: 'conv-1',
    };

    // 只认房主发出的卡片:访客自己伪造的 note-card 不能成为读任意笔记的入口。
    it('resolves a guest note only through a card the host sent', async () => {
      prisma.tempChat.findUnique.mockResolvedValue({ hostUserId: 'host-1' });

      await expect(service.getGuestNote(guest, 'msg-1')).resolves.toEqual({
        id: 'note-1',
      });
      expect(prisma.tempChat.findUnique).toHaveBeenCalledWith({
        where: { id: 'tc-1' },
        select: { hostUserId: true },
      });
      expect(chatService.getNoteCardNoteId).toHaveBeenCalledWith(
        'guest-1',
        'conv-1',
        'msg-1',
        'host-1',
      );
      expect(noteService.getSharedNoteForGuest).toHaveBeenCalledWith('note-1');
    });

    // 房间行没了就没有「房主」可比对 —— 必须 fail closed,不能退化成不限发送者。
    it('resolves nothing when the room row is gone', async () => {
      prisma.tempChat.findUnique.mockResolvedValue(null);

      await expect(service.getGuestNote(guest, 'msg-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(chatService.getNoteCardNoteId).not.toHaveBeenCalled();
      expect(noteService.getSharedNoteForGuest).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('creates the room, TEMP conversation and host seat in one transaction', async () => {
      prisma.tempChat.count.mockResolvedValue(0);
      prisma.tempChat.create.mockResolvedValue({
        id: 'tc-1',
        groupId: 'g-1',
        title: '临时聊天',
        maxMembers: 50,
        expiresAt: future,
      });
      prisma.chatConversation.create.mockResolvedValue({ id: 'conv-1' });

      const result = await service.create('host-1', {});

      expect(prisma.chatConversation.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'TEMP',
            tempChatID: 'tc-1',
            members: { create: [{ userID: 'host-1' }] },
          }),
        }),
      );
      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(result.conversationId).toBe('conv-1');
      expect(result.shareUrl).toBe('https://t.example/t/link-token');
      // 房主在线 socket 即刻入房。
      expect(chatBroadcast.joinUserToConversation).toHaveBeenCalledWith(
        'host-1',
        'conv-1',
      );
    });

    it('enforces the active-room quota under the advisory lock', async () => {
      // 第一次 count 是每日配额,第二次才是活跃房间数。
      prisma.tempChat.count.mockResolvedValueOnce(0).mockResolvedValueOnce(200);
      await expect(service.create('host-1', {})).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tempChat.create).not.toHaveBeenCalled();
    });
  });

  describe('create daily limit', () => {
    let createdAt: Date[];

    const createErrorCode = async (): Promise<unknown> => {
      const error = await service.create('host-1', {}).catch((e) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      return (error as BadRequestException).getResponse();
    };

    beforeEach(() => {
      jest.useFakeTimers();
      createdAt = [];
      // 按 where.createdAt.gte 真实过滤内存里的建房时刻,日界算错就会数错。
      prisma.tempChat.count.mockImplementation(
        ({ where }: { where: { createdAt?: { gte: Date } } }) =>
          Promise.resolve(
            where.createdAt
              ? createdAt.filter((at) => at >= where.createdAt!.gte).length
              : 0,
          ),
      );
      prisma.tempChat.create.mockImplementation(() => {
        createdAt.push(new Date());
        return Promise.resolve({
          id: `tc-${createdAt.length}`,
          groupId: `g-${createdAt.length}`,
          title: '临时聊天',
          maxMembers: 50,
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        });
      });
      prisma.chatConversation.create.mockResolvedValue({ id: 'conv-1' });
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('allows five rooms a day and rejects the sixth with a dedicated code', async () => {
      jest.setSystemTime(Date.parse('2026-10-31T01:00:00Z'));
      for (let i = 0; i < 5; i += 1) {
        await expect(service.create('host-1', {})).resolves.toMatchObject({
          id: `tc-${i + 1}`,
        });
      }

      await expect(createErrorCode()).resolves.toMatchObject({
        errorCode: 'TEMP_CHAT_DAILY_CREATE_LIMIT',
      });
      expect(prisma.tempChat.create).toHaveBeenCalledTimes(5);
    });

    // 日界是北京时间零点(UTC 16:00),删掉的房间也照样计数(count 不带 deletedAt)。
    it('resets at Beijing midnight and still counts deleted rooms', async () => {
      jest.setSystemTime(Date.parse('2026-10-31T15:00:00Z')); // 北京 23:00
      for (let i = 0; i < 5; i += 1) {
        await service.create('host-1', {});
      }
      const [dailyQuery] = prisma.tempChat.count.mock.calls[0] as [
        { where: { hostUserId: string; createdAt: { gte: Date } } },
      ];
      expect(Object.keys(dailyQuery.where)).toEqual([
        'hostUserId',
        'createdAt',
      ]);
      expect(dailyQuery.where.createdAt.gte.getTime()).toBe(
        Date.parse('2026-10-30T16:00:00Z'),
      );

      jest.setSystemTime(Date.parse('2026-10-31T15:59:59Z')); // 北京 23:59:59
      await expect(createErrorCode()).resolves.toMatchObject({
        errorCode: 'TEMP_CHAT_DAILY_CREATE_LIMIT',
      });

      jest.setSystemTime(Date.parse('2026-10-31T16:00:00Z')); // 北京次日 00:00
      await expect(service.create('host-1', {})).resolves.toMatchObject({
        id: 'tc-6',
      });
    });
  });

  describe('getByToken', () => {
    it('returns meta for an active room', async () => {
      linkToken.verify.mockReturnValue({ tcId: 'tc-1' });
      prisma.tempChat.findUnique.mockResolvedValue({
        title: 'T',
        status: 'ACTIVE',
        maxMembers: 50,
        expiresAt: future,
      });
      prisma.tempChatGuest.count.mockResolvedValue(3);
      await expect(service.getByToken('tok')).resolves.toMatchObject({
        title: 'T',
        memberCount: 3,
        full: false,
      });
    });

    it('throws Gone when the room ended', async () => {
      linkToken.verify.mockReturnValue({ tcId: 'tc-1' });
      prisma.tempChat.findUnique.mockResolvedValue({
        status: 'ENDED',
        expiresAt: future,
      });
      await expect(service.getByToken('tok')).rejects.toThrow(GoneException);
    });
  });

  describe('listMine', () => {
    it('returns every currently active room before filling the 200-row history cap', async () => {
      const activeRoom = {
        id: 'tc-active-old',
        groupId: 'g-active-old',
        title: '仍在使用',
        status: 'ACTIVE',
        maxMembers: 50,
        expiresAt: future,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        endedAt: null,
        _count: { guests: 0 },
      };
      const endedRoom = {
        ...activeRoom,
        id: 'tc-ended-new',
        groupId: 'g-ended-new',
        title: '最近已结束',
        status: 'ENDED',
        createdAt: new Date('2026-08-17T00:00:00Z'),
        endedAt: new Date('2026-08-17T01:00:00Z'),
      };
      prisma.tempChat.findMany
        .mockResolvedValueOnce([activeRoom])
        .mockResolvedValueOnce([endedRoom]);
      prisma.chatConversation.findMany.mockResolvedValue([
        { id: 'conv-active', tempChatID: activeRoom.id },
        { id: 'conv-ended', tempChatID: endedRoom.id },
      ]);

      const result = await service.listMine('host-1');

      expect(prisma.tempChat.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: {
            hostUserId: 'host-1',
            deletedAt: null,
            status: 'ACTIVE',
            expiresAt: { gt: expect.any(Date) },
          },
          take: 200,
        }),
      );
      expect(prisma.tempChat.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            hostUserId: 'host-1',
            deletedAt: null,
            id: { notIn: [activeRoom.id] },
          },
          take: 199,
        }),
      );
      expect(result.map((room) => room.id)).toEqual([
        activeRoom.id,
        endedRoom.id,
      ]);
    });
  });

  describe('join', () => {
    beforeEach(() => {
      linkToken.verify.mockReturnValue({ tcId: 'tc-1' });
      prisma.tempChat.findUnique.mockResolvedValue({
        id: 'tc-1',
        status: 'ACTIVE',
        maxMembers: 2,
        expiresAt: future,
      });
      prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      prisma.tempChatGuest.count.mockResolvedValue(0);
      prisma.tempChatGuest.create.mockResolvedValue({ id: 'guest-row' });
      prisma.chatMember.create.mockResolvedValue({});
      sensitiveWords.check.mockReturnValue({ blocked: false });
    });

    it('seats the guest atomically and returns chat-core credentials', async () => {
      const result = await service.join('tok', { displayName: '路人甲' });

      expect(prisma.chatMember.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ conversationID: 'conv-1' }),
        }),
      );
      expect(linkToken.signGuest).toHaveBeenCalledWith(
        expect.objectContaining({ tcId: 'tc-1', conversationId: 'conv-1' }),
        expect.any(Number),
      );
      expect(result).toMatchObject({
        displayName: '路人甲',
        conversationId: 'conv-1',
        chatToken: 'guest-chat-token',
        wsPath: '/chat-ws',
      });
      expect(result.guestId.startsWith('g')).toBe(true);
    });

    // 访客昵称会原样进房主的离线推送(chat-push 用 sender.nickname 拼标题/正文),
    // 与聊天正文、编辑走同一条敏感词闸:命中直接拒,不落座。
    it('rejects a display name that trips the sensitive-word filter before seating', async () => {
      sensitiveWords.check.mockReturnValue({ blocked: true, word: '违规' });

      await expect(
        service.join('tok', { displayName: '违规昵称' }),
      ).rejects.toMatchObject({
        response: { errorCode: ChatErrorCode.SensitiveWord },
      });
      expect(sensitiveWords.check).toHaveBeenCalledWith('违规昵称');
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.chatMember.create).not.toHaveBeenCalled();
    });

    // 换行/控制符会把推送标题折成多行,双向覆盖符能把「管理员」之类的字样倒序伪装出来。
    it('strips control and bidi-override characters before storing the name', async () => {
      const result = await service.join('tok', {
        displayName: ' \u202E路人\u0007甲\u2066\n',
      });

      expect(result.displayName).toBe('路人甲');
      expect(prisma.tempChatGuest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ displayName: '路人甲' }),
      });
      expect(sensitiveWords.check).toHaveBeenCalledWith('路人甲');
    });

    it('falls back to a generated name when nothing printable is left', async () => {
      const result = await service.join('tok', {
        displayName: '\u0000\u202E \u200F',
      });

      expect(result.displayName).toMatch(/^访客\d{4}$/);
    });

    // 零宽连接符是 emoji 家族序列与部分文字的一部分,不是控制符。
    it('keeps emoji joiners intact', async () => {
      const family = '👨\u200D👩\u200D👧';

      const result = await service.join('tok', { displayName: family });

      expect(result.displayName).toBe(family);
    });

    it('rejects when the room is full', async () => {
      prisma.tempChatGuest.count.mockResolvedValue(2);
      await expect(service.join('tok', {})).rejects.toThrow(ConflictException);
      expect(prisma.chatMember.create).not.toHaveBeenCalled();
    });

    it('treats legacy rooms without a conversation as ended', async () => {
      prisma.chatConversation.findUnique.mockResolvedValue(null);
      await expect(service.join('tok', {})).rejects.toThrow(GoneException);
    });

    it('rejects expired rooms', async () => {
      prisma.tempChat.findUnique.mockResolvedValue({
        id: 'tc-1',
        status: 'ACTIVE',
        maxMembers: 2,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(service.join('tok', {})).rejects.toThrow(GoneException);
    });
  });

  describe('end / teardown', () => {
    it('only the host can end the room', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue({
        id: 'tc-1',
        hostUserId: 'host-1',
        status: 'ACTIVE',
      });
      await expect(service.end('intruder', 'tc-1')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('retires guest seats, marks them cleaned and disconnects sockets', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue({
        id: 'tc-1',
        groupId: 'g-1',
        hostUserId: 'host-1',
        status: 'ACTIVE',
      });
      prisma.tempChat.findUnique.mockResolvedValue({
        id: 'tc-1',
        status: 'ACTIVE',
        endedAt: null,
        cleanupCompletedAt: null,
        cleanupLockedAt: null,
      });
      prisma.tempChatGuest.findMany.mockResolvedValue([
        { imUserId: 'g-a' },
        { imUserId: 'g-b' },
      ]);
      prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });

      const result = await service.end('host-1', 'tc-1');

      expect(result.status).toBe('ENDED');
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            conversationID: 'conv-1',
            userID: { in: ['g-a', 'g-b'] },
            leftAt: null,
          }),
          data: { leftAt: expect.any(Date) },
        }),
      );
      expect(prisma.tempChatGuest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { cleanedUp: true } }),
      );
      expect(chatBroadcast.disconnectUser).toHaveBeenCalledWith('g-a');
      expect(chatBroadcast.disconnectUser).toHaveBeenCalledWith('g-b');
    });

    it('skips cleanup when another worker holds a fresh lease', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue({
        id: 'tc-1',
        groupId: 'g-1',
        hostUserId: 'host-1',
        status: 'ACTIVE',
      });
      prisma.tempChat.findUnique.mockResolvedValue({
        id: 'tc-1',
        status: 'ACTIVE',
        endedAt: null,
        cleanupCompletedAt: null,
        cleanupLockedAt: new Date(),
      });

      await service.end('host-1', 'tc-1');
      expect(prisma.chatMember.updateMany).not.toHaveBeenCalled();
      expect(chatBroadcast.disconnectUser).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    const activeRoom = {
      id: 'tc-1',
      groupId: 'g-1',
      hostUserId: 'host-1',
      status: 'ACTIVE',
      deletedAt: null,
    };

    beforeEach(() => {
      prisma.tempChat.updateMany.mockResolvedValue({ count: 1 });
      prisma.chatConversation.findUnique.mockResolvedValue({ id: 'conv-1' });
      prisma.tempChatGuest.findMany.mockResolvedValue([]);
    });

    it('only the host can delete the room', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue(activeRoom);

      await expect(service.remove('intruder', 'tc-1')).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.tempChat.updateMany).not.toHaveBeenCalled();
    });

    it('ends an active room through teardown, then hides it from the host', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue(activeRoom);
      prisma.tempChat.findUnique.mockResolvedValue({
        ...activeRoom,
        endedAt: null,
        cleanupCompletedAt: null,
        cleanupLockedAt: null,
      });
      prisma.tempChatGuest.findMany.mockResolvedValue([{ imUserId: 'g-a' }]);

      await expect(service.remove('host-1', 'tc-1')).resolves.toBeUndefined();

      // 结束:访客离座断线、状态落成 ENDED(链接随之失效)。
      expect(prisma.tempChat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ENDED' }),
        }),
      );
      expect(chatBroadcast.disconnectUser).toHaveBeenCalledWith('g-a');
      // 删除:软删打标 + 房主座位离座 + 通知房主其他设备收走会话。
      expect(prisma.tempChat.updateMany).toHaveBeenCalledWith({
        where: { id: 'tc-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.chatMember.updateMany).toHaveBeenCalledWith({
        where: { conversationID: 'conv-1', userID: 'host-1', leftAt: null },
        data: { leftAt: expect.any(Date) },
      });
      expect(chatBroadcast.removeUserFromConversation).toHaveBeenCalledWith(
        'host-1',
        'conv-1',
      );
      expect(chatBroadcast.emitConversationChange).toHaveBeenCalledWith(
        'host-1',
        { kind: 'left', conversationId: 'conv-1', userId: 'host-1' },
      );
    });

    it('deletes an ended room without tearing it down again', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue({
        ...activeRoom,
        status: 'ENDED',
      });

      await service.remove('host-1', 'tc-1');

      expect(prisma.tempChat.update).not.toHaveBeenCalled();
      expect(prisma.tempChatGuest.findMany).not.toHaveBeenCalled();
      expect(prisma.tempChat.updateMany).toHaveBeenCalledWith({
        where: { id: 'tc-1', deletedAt: null },
        data: { deletedAt: expect.any(Date) },
      });
      expect(chatBroadcast.emitConversationChange).toHaveBeenCalledTimes(1);
    });

    it('is idempotent: deleting an already deleted room is a no-op', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue({
        ...activeRoom,
        status: 'ENDED',
        deletedAt: new Date('2026-10-30T00:00:00Z'),
      });

      await expect(service.remove('host-1', 'tc-1')).resolves.toBeUndefined();
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(chatBroadcast.emitConversationChange).not.toHaveBeenCalled();
    });

    it('leaves the side effects to a concurrent delete that already won', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue({
        ...activeRoom,
        status: 'ENDED',
      });
      prisma.tempChat.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.remove('host-1', 'tc-1')).resolves.toBeUndefined();
      expect(chatBroadcast.removeUserFromConversation).not.toHaveBeenCalled();
      expect(chatBroadcast.emitConversationChange).not.toHaveBeenCalled();
    });
  });

  describe('listGuestMembers', () => {
    // 访客 id 的真实形态（temp-chat.ids.ts newGuestId）：g + 32 位 hex。
    const GUEST_ID = 'g0123456789abcdef0123456789abcdef';
    const guest = {
      kind: 'temp-chat-guest' as const,
      guestId: GUEST_ID,
      tcId: 'tc-1',
      conversationId: 'conv-1',
    };

    it('returns the seated roster and flags the host', async () => {
      prisma.tempChat.findUnique.mockResolvedValue({ hostUserId: 'host-1' });
      chatService.listMembers.mockResolvedValue([
        { userId: 'host-1', nickname: '房主', avatarUrl: 'a.png', role: null },
        { userId: GUEST_ID, nickname: '我', avatarUrl: null, role: null },
      ]);

      const members = await service.listGuestMembers(guest);

      expect(chatService.listMembers).toHaveBeenCalledWith(GUEST_ID, 'conv-1');
      expect(members).toEqual([
        // 房主的账号 UUID 不外发给匿名访客，只给房间内别名；isHost 照旧标出。
        {
          userId: TEMP_CHAT_HOST_ALIAS,
          nickname: '房主',
          avatarUrl: 'a.png',
          isHost: true,
        },
        { userId: GUEST_ID, nickname: '我', avatarUrl: null, isHost: false },
      ]);
    });

    it('still lists members when the room row is gone (nobody flagged host)', async () => {
      prisma.tempChat.findUnique.mockResolvedValue(null);
      chatService.listMembers.mockResolvedValue([
        { userId: GUEST_ID, nickname: '我', avatarUrl: null, role: null },
      ]);

      const members = await service.listGuestMembers(guest);
      expect(members).toEqual([
        { userId: GUEST_ID, nickname: '我', avatarUrl: null, isHost: false },
      ]);
    });

    it('propagates the membership check (a cleared guest gets nothing)', async () => {
      prisma.tempChat.findUnique.mockResolvedValue({ hostUserId: 'host-1' });
      chatService.listMembers.mockRejectedValue(new ForbiddenException());

      await expect(service.listGuestMembers(guest)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('getGuestHistory', () => {
    const GUEST_ID = 'g0123456789abcdef0123456789abcdef';
    const guest = {
      kind: 'temp-chat-guest' as const,
      guestId: GUEST_ID,
      tcId: 'tc-1',
      conversationId: 'conv-1',
    };
    const base = {
      conversationId: 'conv-1',
      type: 'text',
      content: { text: 'hi' },
      replyToId: null,
      revokedAt: null,
      revokedBy: null,
      burnDurationSec: null,
      createdAt: '2026-09-13T00:00:00.000Z',
    };
    const hostSender = {
      id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
      nickname: '房主',
      avatarUrl: null,
      alias: null,
    };
    const ownSender = {
      id: GUEST_ID,
      nickname: '我',
      avatarUrl: null,
      alias: null,
    };

    // 与 chat:msg 的访客视图同一口径：房主 id 换成房间内别名；d 只有访客自己发的保留。
    it('serves the room history with the host id aliased and foreign delivery ids stripped', async () => {
      const hostMessage = {
        ...base,
        id: 'm-1',
        height: 1,
        sender: hostSender,
        d: 'host-delivery-id',
      };
      const ownMessage = {
        ...base,
        id: 'm-2',
        height: 2,
        sender: ownSender,
        d: 'own-delivery-id',
      };
      chatService.getHistory.mockResolvedValue({
        messages: [hostMessage, ownMessage],
        nextBeforeHeight: null,
      });

      const page = await service.getGuestHistory(guest, {
        beforeHeight: 10,
        limit: 20,
      });

      expect(chatService.getHistory).toHaveBeenCalledWith(
        GUEST_ID,
        'conv-1',
        10,
        20,
        { afterHeight: undefined },
      );
      expect(page).toEqual({
        messages: [
          {
            ...hostMessage,
            d: null,
            sender: { ...hostSender, id: TEMP_CHAT_HOST_ALIAS },
          },
          ownMessage,
        ],
        nextBeforeHeight: null,
      });
    });
  });
});
