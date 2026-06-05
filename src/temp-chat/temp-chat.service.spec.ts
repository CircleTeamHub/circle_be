import { GoneException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { OpenimService } from 'src/openim/openim.service';
import { LinkTokenService } from './link-token.service';
import { TempChatService } from './temp-chat.service';

const buildRow = (o: Partial<any> = {}) => ({
  id: 'tc-1',
  groupId: 'tmpABC',
  hostUserId: 'host-1',
  title: '临时聊天',
  status: 'ACTIVE',
  maxMembers: 50,
  expiresAt: new Date(Date.now() + 3 * 24 * 3600 * 1000),
  endedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

describe('TempChatService', () => {
  let service: TempChatService;

  const prisma = {
    tempChat: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn(),
    },
    tempChatGuest: {
      create: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    $transaction: jest.fn((cb: any) => cb(prisma)),
  };
  const openim = {
    createGroup: jest.fn(),
    dismissGroup: jest.fn(),
    registerUser: jest.fn(),
    addGroupMembers: jest.fn(),
    getUserToken: jest.fn(),
    forceLogout: jest.fn(),
  };
  const linkToken = { sign: jest.fn(() => 'signed-token'), verify: jest.fn() };
  const config = {
    get: (k: string, d?: any) =>
      ({
        TEMP_CHAT_WEB_BASE: 'https://chat.example.com',
        TEMP_CHAT_DEFAULT_TTL_MINUTES: 4320,
        TEMP_CHAT_MAX_MEMBERS: 50,
        OPENIM_IM_WS_URL: 'wss://im.example.com/ws',
        OPENIM_IM_API_URL: 'https://im.example.com',
      })[k] ?? d,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    // OpenIM 方法都是 async（返回 Promise<void>）；mock 默认 resolve，
    // 这样 service 里的 `.catch()` 调用在测试中行为与生产一致。
    openim.createGroup.mockResolvedValue(undefined);
    openim.dismissGroup.mockResolvedValue(undefined);
    openim.registerUser.mockResolvedValue(undefined);
    openim.addGroupMembers.mockResolvedValue(undefined);
    openim.forceLogout.mockResolvedValue(undefined);
    const mod = await Test.createTestingModule({
      providers: [
        TempChatService,
        { provide: PrismaService, useValue: prisma },
        { provide: OpenimService, useValue: openim },
        { provide: LinkTokenService, useValue: linkToken },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = mod.get(TempChatService);
  });

  describe('create', () => {
    it('creates OpenIM group then persists and returns shareUrl', async () => {
      prisma.tempChat.create.mockResolvedValue(buildRow());
      const res = await service.create('host-1', { title: '周末爬山' });

      expect(openim.createGroup).toHaveBeenCalledWith(
        expect.stringMatching(/^tmp/),
        '周末爬山',
        'host-1',
        ['host-1'],
      );
      expect(res.shareUrl).toBe('https://chat.example.com/t/signed-token');
      expect(res.groupId).toMatch(/^tmp/);
    });

    it('rolls back the OpenIM group if persistence fails', async () => {
      prisma.tempChat.create.mockRejectedValue(new Error('db down'));
      await expect(service.create('host-1', {})).rejects.toThrow('db down');
      expect(openim.dismissGroup).toHaveBeenCalledWith(
        expect.stringMatching(/^tmp/),
      );
    });

    it('applies default ttl (3 days) and maxMembers (50)', async () => {
      prisma.tempChat.create.mockResolvedValue(buildRow());
      await service.create('host-1', {});
      const data = prisma.tempChat.create.mock.calls[0][0].data;
      expect(data.maxMembers).toBe(50);
      const ms = new Date(data.expiresAt).getTime() - Date.now();
      expect(ms).toBeGreaterThan(4319 * 60 * 1000);
      expect(ms).toBeLessThan(4321 * 60 * 1000);
    });
  });

  describe('getByToken', () => {
    it('returns room meta for an active room', async () => {
      linkToken.verify.mockReturnValue({ tcId: 'tc-1' });
      prisma.tempChat.findUnique.mockResolvedValue(buildRow());
      prisma.tempChatGuest.count.mockResolvedValue(7);
      const meta = await service.getByToken('signed-token');
      expect(meta).toMatchObject({
        title: '临时聊天',
        memberCount: 7,
        maxMembers: 50,
        full: false,
      });
    });

    it('throws Gone when room already ended', async () => {
      linkToken.verify.mockReturnValue({ tcId: 'tc-1' });
      prisma.tempChat.findUnique.mockResolvedValue(
        buildRow({ status: 'ENDED' }),
      );
      prisma.tempChatGuest.count.mockResolvedValue(0);
      await expect(service.getByToken('signed-token')).rejects.toBeInstanceOf(
        GoneException,
      );
    });
  });

  describe('listMine', () => {
    it('lists rooms owned by the current user with newest first and guest counts', async () => {
      const active = buildRow({
        id: 'tc-active',
        groupId: 'tmpActive',
        title: '售前咨询',
        createdAt: new Date('2026-06-05T03:00:00.000Z'),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        _count: { guests: 2 },
      });
      const ended = buildRow({
        id: 'tc-ended',
        groupId: 'tmpEnded',
        title: '已结束',
        status: 'ENDED',
        createdAt: new Date('2026-06-04T03:00:00.000Z'),
        endedAt: new Date('2026-06-04T04:00:00.000Z'),
        _count: { guests: 1 },
      });
      prisma.tempChat.findMany.mockResolvedValue([active, ended]);

      const rooms = await service.listMine('host-1');

      expect(prisma.tempChat.findMany).toHaveBeenCalledWith({
        where: { hostUserId: 'host-1' },
        orderBy: [{ createdAt: 'desc' }],
        include: { _count: { select: { guests: true } } },
      });
      expect(rooms).toEqual([
        expect.objectContaining({
          id: 'tc-active',
          groupId: 'tmpActive',
          title: '售前咨询',
          status: 'ACTIVE',
          guestCount: 2,
          memberCount: 3,
          shareUrl: 'https://chat.example.com/t/signed-token',
        }),
        expect.objectContaining({
          id: 'tc-ended',
          groupId: 'tmpEnded',
          status: 'ENDED',
          guestCount: 1,
          memberCount: 2,
          shareUrl: null,
        }),
      ]);
      expect(linkToken.sign).toHaveBeenCalledWith(
        'tc-active',
        expect.any(Number),
      );
    });
  });

  describe('join', () => {
    beforeEach(() => {
      linkToken.verify.mockReturnValue({ tcId: 'tc-1' });
      prisma.tempChat.findUnique.mockResolvedValue(buildRow());
      prisma.tempChatGuest.count.mockResolvedValue(3);
      prisma.tempChatGuest.create.mockResolvedValue({});
      openim.getUserToken.mockResolvedValue('guest-im-token');
    });

    it('mints a guest, adds to group, returns web im credentials', async () => {
      const res = await service.join('signed-token', { displayName: '小明' });
      expect(openim.registerUser).toHaveBeenCalledWith(
        expect.stringMatching(/^g/),
        '小明',
      );
      expect(openim.addGroupMembers).toHaveBeenCalledWith('tmpABC', [
        expect.stringMatching(/^g/),
      ]);
      expect(openim.getUserToken).toHaveBeenCalledWith(
        expect.stringMatching(/^g/),
        5,
      );
      expect(res).toMatchObject({
        imToken: 'guest-im-token',
        groupId: 'tmpABC',
        wsUrl: 'wss://im.example.com/ws',
        apiUrl: 'https://im.example.com',
      });
    });

    it('rejects when room is full', async () => {
      prisma.tempChatGuest.count.mockResolvedValue(50);
      await expect(service.join('signed-token', {})).rejects.toMatchObject({
        status: 409,
      });
    });

    it('rejects when room expired', async () => {
      prisma.tempChat.findUnique.mockResolvedValue(
        buildRow({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.join('signed-token', {})).rejects.toMatchObject({
        status: 410,
      });
    });

    it('compensates (deletes guest row) if OpenIM add fails', async () => {
      prisma.tempChatGuest.create.mockResolvedValue({ id: 'guest-1' });
      openim.addGroupMembers.mockRejectedValue(new Error('im down'));
      await expect(service.join('signed-token', {})).rejects.toBeDefined();
      expect(prisma.tempChatGuest.delete).toHaveBeenCalledWith({
        where: { id: 'guest-1' },
      });
    });
  });

  describe('end', () => {
    it('only the host can end the room', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue(buildRow());
      await expect(service.end('someone-else', 'tc-1')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('host ends → dismiss group + status ENDED', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue(buildRow());
      prisma.tempChatGuest.findMany.mockResolvedValue([{ imUserId: 'gA' }]);
      prisma.tempChat.update.mockResolvedValue(buildRow({ status: 'ENDED' }));
      const res = await service.end('host-1', 'tc-1');
      expect(openim.dismissGroup).toHaveBeenCalledWith('tmpABC');
      expect(openim.forceLogout).toHaveBeenCalledWith('gA');
      expect(res.status).toBe('ENDED');
    });

    it('ending an already-ended room is idempotent (no dismiss)', async () => {
      prisma.tempChat.findUniqueOrThrow.mockResolvedValue(
        buildRow({ status: 'ENDED' }),
      );
      const res = await service.end('host-1', 'tc-1');
      expect(openim.dismissGroup).not.toHaveBeenCalled();
      expect(res.status).toBe('ENDED');
    });
  });
});
