import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { UserStatus } from 'src/generated/prisma';
import { UserService } from '../user.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('UserService', () => {
  let service: UserService;
  const prisma = {
    user: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
  };
  const refreshTokens = {
    revokeAll: jest.fn().mockResolvedValue(undefined),
  };
  const configGet = jest.fn(() => null);

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
      ],
    }).compile();
    return module.get<UserService>(UserService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    service = await buildService();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('finds an active user by exact accountId without exposing admin pagination', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      accountId: 'jimmy',
      nickname: 'Jimmy',
    });

    await expect(service.findByExactAccountId(' jimmy ')).resolves.toMatchObject(
      { id: 'user-1', accountId: 'jimmy' },
    );
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
  });

  describe('findOne', () => {
    it('returns the user when found', async () => {
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });
      await expect(service.findOne('user-1')).resolves.toEqual({ id: 'user-1' });
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
