import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';
import { SessionRevocationService } from '../session-revocation.service';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  const records: any[] = [];
  const loopbackIp = ['127', '0', '0', '1'].join('.');
  const privateIp = ['10', '0', '0', '1'].join('.');

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
        const matching = records.filter((record) => {
          if (where.userId && record.userId !== where.userId) return false;
          if (where.token && record.token !== where.token) return false;
          if (where.audience && record.audience !== where.audience) {
            return false;
          }
          if (typeof where.id === 'string' && record.id !== where.id) {
            return false;
          }
          if (where.id?.not && record.id === where.id.not) {
            return false;
          }
          if (where.revokedAt === null && record.revokedAt !== null) {
            return false;
          }
          if (where.expiredAt?.gt && record.expiredAt <= where.expiredAt.gt) {
            return false;
          }
          return true;
        });
        matching.forEach((record) => Object.assign(record, data));
        return { count: matching.length };
      }),
      updateManyAndReturn: jest.fn(async ({ where, data }) => {
        const matching = records.filter((record) => {
          if (where.userId && record.userId !== where.userId) return false;
          if (where.id?.not && record.id === where.id.not) return false;
          if (where.revokedAt === null && record.revokedAt !== null) {
            return false;
          }
          return true;
        });
        matching.forEach((record) => Object.assign(record, data));
        return matching.map(({ id }) => ({ id }));
      }),
    },
  };

  const config = { get: jest.fn().mockReturnValue(undefined) };
  const revocation = {
    revokeUser: jest.fn().mockResolvedValue(undefined),
    revokeSession: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    records.length = 0;
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefreshTokenService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: SessionRevocationService, useValue: revocation },
      ],
    }).compile();

    service = module.get<RefreshTokenService>(RefreshTokenService);
  });

  it('stores device metadata when creating a session, truncating overlong values', async () => {
    const longName = 'x'.repeat(200);
    const session = await service.create('user-1', {
      deviceName: longName,
      ip: loopbackIp,
      userAgent: 'PostmanRuntime',
    });

    expect(session).toMatchObject({
      token: expect.any(String),
      sessionId: 'session-1',
    });
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          deviceName: longName.slice(0, 64),
          ip: loopbackIp,
          userAgent: 'PostmanRuntime',
        }),
      }),
    );
  });

  it('stores app audience by default and admin audience when requested', async () => {
    await service.create('user-1');
    await service.create('user-1', undefined, 'ADMIN');

    expect(records[0].audience).toBe('APP');
    expect(records[1].audience).toBe('ADMIN');
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
        ip: loopbackIp,
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
    // F-02: also kills the user's outstanding access tokens.
    expect(revocation.revokeUser).toHaveBeenCalledWith('user-1');
  });

  it('revokes a single active session for the owning user', async () => {
    const now = new Date();
    records.push(
      {
        id: 'session-1',
        userId: 'user-1',
        token: 'token-1',
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
      },
      {
        id: 'session-2',
        userId: 'user-2',
        token: 'token-2',
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
      },
    );

    await service.revokeSession('user-1', 'session-1');
    await service.revokeSession('user-1', 'session-2');

    expect(records[0].revokedAt).toBeInstanceOf(Date);
    expect(records[1].revokedAt).toBeNull();
    // F-02: also kills the matching session's access token.
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-1');
  });

  it('revokes all active sessions except the current session', async () => {
    const now = new Date();
    records.push(
      {
        id: 'current',
        userId: 'user-1',
        token: 'token-1',
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
      },
      {
        id: 'other',
        userId: 'user-1',
        token: 'token-2',
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
      },
    );

    await service.revokeOtherSessions('user-1', 'current');

    expect(records[0].revokedAt).toBeNull();
    expect(records[1].revokedAt).toBeInstanceOf(Date);
    expect(prisma.refreshToken.updateManyAndReturn).toHaveBeenCalled();
    expect(revocation.revokeSession).toHaveBeenCalledTimes(1);
    expect(revocation.revokeSession).toHaveBeenCalledWith('other');
  });

  it('does not revoke sessions when the current session id is missing', async () => {
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

    await service.revokeOtherSessions('user-1');

    expect(records[0].revokedAt).toBeNull();
  });

  it('rotates a valid refresh token and revokes the old record', async () => {
    const { token: raw } = await service.create('user-1', {
      deviceName: 'MacBook',
      ip: loopbackIp,
      userAgent: 'PostmanRuntime',
    });

    const {
      token: newRaw,
      userId,
      sessionId,
    } = await service.rotate(raw, {
      ip: privateIp,
    });

    expect(userId).toBe('user-1');
    expect(newRaw).not.toBe(raw);
    expect(records).toHaveLength(2);
    expect(sessionId).toBe('session-2');

    const oldRecord = records[0];
    const newRecord = records[1];
    expect(oldRecord.revokedAt).toBeInstanceOf(Date);
    expect(newRecord.revokedAt).toBeNull();
    expect(newRecord.ip).toBe(privateIp);
    // Carries over device name from the old session when not supplied.
    expect(newRecord.deviceName).toBe('MacBook');
  });

  it('carries the refresh token audience when rotating', async () => {
    const { token: raw } = await service.create('user-1', undefined, 'ADMIN');

    await service.rotate(raw, undefined, 'ADMIN');

    expect(records[1].audience).toBe('ADMIN');
  });

  it('rejects rotating a refresh token for the wrong audience without revoking it', async () => {
    const { token: raw } = await service.create('user-1', undefined, 'APP');

    await expect(service.rotate(raw, undefined, 'ADMIN')).rejects.toThrow(
      UnauthorizedException,
    );

    expect(records[0].revokedAt).toBeNull();
    expect(records).toHaveLength(1);
  });

  it('detects refresh token reuse and revokes all sessions for the user', async () => {
    const { token: raw } = await service.create('user-1');

    // Rotate once — valid. Second rotation with the same old token is a replay.
    await service.rotate(raw);

    // Second session created above; capture for the assertion below.
    const newSessionAfterFirstRotate = records[1];
    expect(newSessionAfterFirstRotate.revokedAt).toBeNull();

    await expect(service.rotate(raw)).rejects.toThrow(UnauthorizedException);
    await expect(service.rotate(raw)).rejects.toThrow(/reuse detected/i);

    // Every active session for the user should now be revoked.
    expect(newSessionAfterFirstRotate.revokedAt).toBeInstanceOf(Date);
  });

  it('rejects rotating an unknown refresh token', async () => {
    await expect(service.rotate('missing-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
