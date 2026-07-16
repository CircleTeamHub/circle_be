import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { ConfigService } from '@nestjs/config';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { UserStatus } from 'src/generated/prisma';
import { UserService } from '../user.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { IconService } from 'src/icon/icon.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { PrivacySettingsService } from 'src/privacy/privacy-settings.service';
import { OpenimService } from 'src/openim/openim.service';

describe('UserService', () => {
  let service: UserService;
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userLike: {
      findUnique: jest.fn(),
    },
    userProfileSyncOutbox: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn(async (operation: any) => operation(prisma)),
  };
  const refreshTokens = {
    revokeAll: jest.fn().mockResolvedValue(undefined),
  };
  const configGet = jest.fn(() => null);
  const iconService = {
    getDisplayIconsForUser: jest.fn(() => Promise.resolve([])),
  };
  const realtimeService = {
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(() => Promise.resolve()),
  };
  const privacySettings = {
    canViewProfileField: jest.fn(),
  };
  const openim = {
    updateUserInfo: jest.fn().mockResolvedValue(undefined),
  };

  async function buildService(
    overrides: { configGet?: (key: string) => string | null } = {},
  ): Promise<UserService> {
    const getter = overrides.configGet ?? configGet;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: getter } },
        { provide: RefreshTokenService, useValue: refreshTokens },
        { provide: IconService, useValue: iconService },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: PrivacySettingsService, useValue: privacySettings },
        { provide: OpenimService, useValue: openim },
      ],
    }).compile();
    return module.get<UserService>(UserService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    privacySettings.canViewProfileField.mockResolvedValue(true);
    prisma.userLike.findUnique.mockResolvedValue(null);
    service = await buildService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('creates an independent canonical invite code with an explicit account ID', async () => {
    prisma.user.create.mockResolvedValue({ id: 'user-1' });

    await service.create({
      accountId: 'Alice_01',
      password: 'password1',
      nickname: 'Alice',
    });

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        accountId: 'Alice_01',
        inviteCode: expect.stringMatching(/^[a-z0-9]{6}$/),
        passwordHash: expect.any(String),
        nickname: 'Alice',
      },
      select: expect.any(Object),
    });
  });

  it('returns service unavailable when admin-user invite-code collisions are exhausted', async () => {
    prisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['inviteCode'] },
      }),
    );

    await expect(
      service.create({
        accountId: 'Alice_02',
        password: 'password1',
        nickname: 'Alice',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.user.create).toHaveBeenCalledTimes(10);
  });

  it('does not retry when the explicit account ID is already taken', async () => {
    const accountIdCollision = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['accountId'] },
      },
    );
    prisma.user.create.mockRejectedValue(accountIdCollision);

    await expect(
      service.create({
        accountId: 'Alice_03',
        password: 'password1',
        nickname: 'Alice',
      }),
    ).rejects.toBe(accountIdCollision);
    expect(prisma.user.create).toHaveBeenCalledTimes(1);
  });

  it('finds an active user by exact accountId without exposing admin pagination', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });

    await expect(
      service.findByExactAccountId(' jimmy '),
    ).resolves.toMatchObject({ id: 'user-1', accountId: 'jimmy' });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        accountId: { equals: 'jimmy', mode: 'insensitive' },
        status: 'ACTIVE',
      },
      select: expect.any(Object),
    });
  });

  it('returns null for empty accountId search keywords', async () => {
    await expect(service.findByExactAccountId('   ')).resolves.toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  describe('findAll', () => {
    it('paginates with the supplied limit and skip', async () => {
      prisma.user.findMany.mockResolvedValue([{ id: 'user-1' }]);
      prisma.user.count.mockResolvedValue(7);

      const result = await service.findAll({ page: 2, limit: 5 });

      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: undefined,
        select: expect.any(Object),
        take: 5,
        skip: 5,
      });
      expect(prisma.user.count).toHaveBeenCalledWith({ where: undefined });
      expect(result).toEqual({
        data: [{ id: 'user-1' }],
        total: 7,
        page: 2,
        limit: 5,
      });
    });

    it('filters by accountId substring when supplied', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findAll({ accountId: 'foo' });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { accountId: { contains: 'foo' } },
        }),
      );
    });

    it('filters by status when supplied', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findAll({ status: UserStatus.BANNED });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: UserStatus.BANNED },
        }),
      );
      expect(prisma.user.count).toHaveBeenCalledWith({
        where: { status: UserStatus.BANNED },
      });
    });

    it('filters by accountId substring and status together', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.findAll({
        accountId: 'foo',
        status: UserStatus.ACTIVE,
      });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            accountId: { contains: 'foo' },
            status: UserStatus.ACTIVE,
          },
        }),
      );
    });
  });

  describe('findOne', () => {
    it('returns the user (with like status) when found', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        receivedLikeCount: 4,
      });
      // Self-view: likedByMeToday is always false and no like lookup is made.
      await expect(service.findOne('user-1')).resolves.toMatchObject({
        id: 'user-1',
        displayIcons: [],
        likeCount: 4,
        likedByMeToday: false,
      });
      expect(prisma.userLike.findUnique).not.toHaveBeenCalled();
    });

    it('filters contact fields according to target privacy settings for other viewers', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'target-1',
        phoneNumber: '13800000000',
        wechat: 'wxid_target',
        qq: '10001',
      });
      privacySettings.canViewProfileField.mockImplementation(
        async (_targetId: string, field: string) => field === 'wechat',
      );

      await expect(
        service.findOne('target-1', 'viewer-1'),
      ).resolves.toMatchObject({
        id: 'target-1',
        phoneNumber: null,
        wechat: 'wxid_target',
        qq: null,
        displayIcons: [],
        likedByMeToday: false,
      });
    });

    it('throws NotFoundException when missing', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.findOne('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.user.update.mockResolvedValue({ id: 'user-1' });
    });

    it('rejects URL fields that fall outside MINIO_PUBLIC_URL when configured', async () => {
      const guarded = await buildService({
        configGet: () => 'http://10.0.0.195:9000',
      });

      await expect(
        guarded.update('user-1', { avatarUrl: 'http://evil.example.com/x' }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('passes the update through when URL fields match the storage prefix', async () => {
      const guarded = await buildService({
        configGet: () => 'http://10.0.0.195:9000',
      });

      await guarded.update('user-1', {
        avatarUrl: 'http://10.0.0.195:9000/circle/avatars/me.png',
      });
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('skips URL safety check when MINIO is not configured', async () => {
      await service.update('user-1', {
        avatarUrl: 'https://example.com/x.png',
      });
      expect(prisma.user.update).toHaveBeenCalled();
      expect(
        realtimeService.invalidateUserProfileSummaryCache,
      ).toHaveBeenCalledWith('user-1');
      // Invalidate the profile-summary hot cache before broadcasting the change.
      expect(
        realtimeService.invalidateUserProfileSummaryCache.mock
          .invocationCallOrder[0],
      ).toBeLessThan(
        realtimeService.broadcastUserProfileSummary.mock.invocationCallOrder[0],
      );
    });

    it('normalizes a YYYY-MM-DD birthday into a UTC Date', async () => {
      await service.update('user-1', { birthday: '2018-04-04' });
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            birthday: new Date('2018-04-04T00:00:00.000Z'),
          }),
        }),
      );
    });

    it('throws BadRequestException for unparseable birthday strings', async () => {
      await expect(
        service.update('user-1', { birthday: 'not-a-date' as any }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('remove + updateStatus', () => {
    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      prisma.user.update.mockResolvedValue({ id: 'user-1' });
    });

    it('remove soft-deletes and revokes all sessions', async () => {
      await service.remove('user-1');
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'user-1' },
          data: { status: UserStatus.DELETED },
        }),
      );
      expect(refreshTokens.revokeAll).toHaveBeenCalledWith('user-1');
    });

    it('updateStatus to BANNED revokes sessions', async () => {
      await service.updateStatus('user-1', UserStatus.BANNED);
      expect(refreshTokens.revokeAll).toHaveBeenCalledWith('user-1');
    });

    it('updateStatus back to ACTIVE does not revoke sessions', async () => {
      await service.updateStatus('user-1', UserStatus.ACTIVE);
      expect(refreshTokens.revokeAll).not.toHaveBeenCalled();
    });
  });
});
