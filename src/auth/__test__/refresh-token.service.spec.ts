import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  const records: any[] = [];

  const prisma = {
    refreshToken: {
      create: jest.fn(async ({ data }) => {
        const record = {
          id: `session-${records.length + 1}`,
          createdAt: new Date(),
          lastUsedAt: new Date(),
          revokedAt: null,
          ...data,
        };
        records.push(record);
        return record;
      }),
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          records.find((record) => record.token === where.token) ?? null,
        ),
      ),
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          records.filter(
            (record) =>
              record.userId === where.userId &&
              record.revokedAt === where.revokedAt &&
              record.expiredAt > where.expiredAt.gt,
          ),
        ),
      ),
      update: jest.fn(async ({ where, data }) => {
        const record = records.find((item) => item.id === where.id);
        Object.assign(record, data);
        return record;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const matching = records.filter(
          (record) =>
            (where.userId ? record.userId === where.userId : true) &&
            (where.token ? record.token === where.token : true) &&
            (where.revokedAt === null ? record.revokedAt === null : true),
        );
        matching.forEach((record) => Object.assign(record, data));
        return { count: matching.length };
      }),
    },
  };

  beforeEach(async () => {
    records.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<RefreshTokenService>(RefreshTokenService);
  });

  it('stores device metadata when creating a session', async () => {
    await service.create('user-1', {
      deviceName: 'MacBook Pro',
      ip: '127.0.0.1',
      userAgent: 'PostmanRuntime',
    });

    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          deviceName: 'MacBook Pro',
          ip: '127.0.0.1',
          userAgent: 'PostmanRuntime',
        }),
      }),
    );
  });

  it('lists only active sessions for a user', async () => {
    const now = new Date();
    records.push(
      {
        id: 'active',
        userId: 'user-1',
        token: 'active-token',
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
        deviceName: 'Active device',
        ip: '127.0.0.1',
        userAgent: 'PostmanRuntime',
      },
      {
        id: 'revoked',
        userId: 'user-1',
        token: 'revoked-token',
        revokedAt: now,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
      },
    );

    const sessions = await service.listActiveSessions('user-1');

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('active');
  });

  it('revokes all active sessions for a user', async () => {
    const now = new Date();
    records.push({
      id: 'session-1',
      userId: 'user-1',
      token: 'token-1',
      revokedAt: null,
      expiredAt: new Date(now.getTime() + 1000 * 60),
      createdAt: now,
      lastUsedAt: now,
    });

    await service.revokeAll('user-1');

    expect(records[0].revokedAt).toBeInstanceOf(Date);
  });

  it('rejects rotating an invalid refresh token', async () => {
    await expect(service.rotate('missing-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
