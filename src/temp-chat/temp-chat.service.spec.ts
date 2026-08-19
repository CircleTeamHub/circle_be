import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
} from '@nestjs/common';
import { TempChatService } from './temp-chat.service';

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
  };
  const chatService = {
    listMembers: jest.fn().mockResolvedValue([]),
    getNoteCardNoteId: jest.fn(),
  };
  const noteService = {
    getSharedNoteForGuest: jest.fn(),
  };

  const service = new TempChatService(
    prisma as never,
    linkToken as never,
    config as never,
    chatBroadcast as never,
    chatService as never,
    noteService as never,
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
    chatService.listMembers.mockResolvedValue([]);
    chatService.getNoteCardNoteId.mockResolvedValue('note-1');
    noteService.getSharedNoteForGuest.mockResolvedValue({ id: 'note-1' });
  });

  it('resolves a guest note through the authorized card in that conversation', async () => {
    const guest = {
      kind: 'temp-chat-guest' as const,
      guestId: 'guest-1',
      tcId: 'tc-1',
      conversationId: 'conv-1',
    };

    await expect(service.getGuestNote(guest, 'msg-1')).resolves.toEqual({
      id: 'note-1',
    });
    expect(chatService.getNoteCardNoteId).toHaveBeenCalledWith(
      'guest-1',
      'conv-1',
      'msg-1',
    );
    expect(noteService.getSharedNoteForGuest).toHaveBeenCalledWith('note-1');
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
      prisma.tempChat.count.mockResolvedValue(200);
      await expect(service.create('host-1', {})).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.tempChat.create).not.toHaveBeenCalled();
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

  describe('listGuestMembers', () => {
    const guest = {
      kind: 'temp-chat-guest' as const,
      guestId: 'guest-1',
      tcId: 'tc-1',
      conversationId: 'conv-1',
    };

    it('returns the seated roster and flags the host', async () => {
      prisma.tempChat.findUnique.mockResolvedValue({ hostUserId: 'host-1' });
      chatService.listMembers.mockResolvedValue([
        { userId: 'host-1', nickname: '房主', avatarUrl: 'a.png', role: null },
        { userId: 'guest-1', nickname: '我', avatarUrl: null, role: null },
      ]);

      const members = await service.listGuestMembers(guest);

      expect(chatService.listMembers).toHaveBeenCalledWith('guest-1', 'conv-1');
      expect(members).toEqual([
        {
          userId: 'host-1',
          nickname: '房主',
          avatarUrl: 'a.png',
          isHost: true,
        },
        { userId: 'guest-1', nickname: '我', avatarUrl: null, isHost: false },
      ]);
    });

    it('still lists members when the room row is gone (nobody flagged host)', async () => {
      prisma.tempChat.findUnique.mockResolvedValue(null);
      chatService.listMembers.mockResolvedValue([
        { userId: 'guest-1', nickname: '我', avatarUrl: null, role: null },
      ]);

      const members = await service.listGuestMembers(guest);
      expect(members).toEqual([
        { userId: 'guest-1', nickname: '我', avatarUrl: null, isHost: false },
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
});
