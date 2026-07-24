import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';
import { SessionRevocationService } from '../session-revocation.service';

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  const records: any[] = [];
  const userSettings = new Map<string, boolean>();
  const loopbackIp = ['127', '0', '0', '1'].join('.');
  const privateIp = ['10', '0', '0', '1'].join('.');

  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (callback) => callback(prisma)),
    user: {
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          userSettings.has(where.id)
            ? {
                id: where.id,
                singleDeviceLoginEnabled: userSettings.get(where.id),
              }
            : null,
        ),
      ),
      update: jest.fn(async ({ where, data }) => {
        userSettings.set(where.id, data.singleDeviceLoginEnabled);
        return { id: where.id };
      }),
    },
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
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(
          records.find(
            (record) =>
              record.id === where.id &&
              record.userId === where.userId &&
              (where.audience === undefined ||
                record.audience === where.audience) &&
              record.revokedAt === null &&
              record.expiredAt > where.expiredAt.gt,
          ) ?? null,
        ),
      ),
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          records.filter(
            (record) =>
              record.userId === where.userId &&
              (where.audience === undefined ||
                record.audience === where.audience) &&
              (where.familyId === undefined ||
                record.familyId === where.familyId) &&
              (where.id?.not === undefined || record.id !== where.id.not) &&
              (where.revokedAt === undefined ||
                record.revokedAt === where.revokedAt) &&
              (where.expiredAt?.gt === undefined ||
                record.expiredAt > where.expiredAt.gt) &&
              (where.createdAt?.gt === undefined ||
                record.createdAt > where.createdAt.gt),
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
          if (where.familyId && record.familyId !== where.familyId) {
            return false;
          }
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
    userSettings.clear();
    userSettings.set('user-1', false);
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
    expect(revocation.revokeSession).toHaveBeenCalledTimes(1);
    expect(revocation.revokeSession).not.toHaveBeenCalledWith('session-2');
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

  it('replaces single-device sessions under a per-user transaction lock', async () => {
    await service.create('user-1');

    const replacement = await (service as any).replaceForSingleDevice(
      'user-1',
      { deviceName: 'replacement' },
      'APP',
    );

    expect(replacement.sessionId).toBe('session-2');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(records.filter((record) => record.revokedAt === null)).toHaveLength(
      1,
    );
    expect(records[1].deviceName).toBe('replacement');
  });

  it('uses the validated REFRESH_EXPIRES_IN duration for session expiry', async () => {
    const configured = new RefreshTokenService(
      prisma as any,
      {
        get: jest.fn((key: string) =>
          key === 'REFRESH_EXPIRES_IN' ? '36h' : undefined,
        ),
      } as any,
      revocation as any,
    );
    const before = Date.now();

    await configured.create('user-1');

    const after = Date.now();
    const thirtySixHours = 36 * 60 * 60 * 1000;
    expect(records[0].expiredAt.getTime()).toBeGreaterThanOrEqual(
      before + thirtySixHours,
    );
    expect(records[0].expiredAt.getTime()).toBeLessThanOrEqual(
      after + thirtySixHours,
    );
  });

  it('cannot late-revoke the winning concurrent single-device session', async () => {
    await service.create('user-1');
    let releaseLateRevocation!: () => void;
    const lateRevocation = new Promise<void>((resolve) => {
      releaseLateRevocation = resolve;
    });
    let signalRevocationStarted!: () => void;
    const revocationStarted = new Promise<void>((resolve) => {
      signalRevocationStarted = resolve;
    });
    revocation.revokeUser.mockImplementationOnce(() => {
      signalRevocationStarted();
      return lateRevocation;
    });
    revocation.revokeSession.mockImplementationOnce(() => {
      signalRevocationStarted();
      return lateRevocation;
    });

    const first = service.replaceForSingleDevice(
      'user-1',
      { deviceName: 'first' },
      'APP',
    );
    await revocationStarted;
    const second = await service.replaceForSingleDevice(
      'user-1',
      { deviceName: 'second' },
      'APP',
    );
    releaseLateRevocation();
    await first;

    expect(second.sessionId).toBe('session-3');
    expect(records.filter((record) => record.revokedAt === null)).toEqual([
      expect.objectContaining({
        id: 'session-3',
        deviceName: 'second',
      }),
    ]);
    expect(revocation.revokeUser).not.toHaveBeenCalled();
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-1');
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-2');
  });

  it('revokes access tokens for active and already-rotated unexpired sessions', async () => {
    const { token: firstToken } = await service.create('user-1');
    await service.rotate(firstToken);
    jest.clearAllMocks();

    const replacement = await service.replaceForSingleDevice(
      'user-1',
      { deviceName: 'single device' },
      'APP',
    );

    expect(replacement.sessionId).toBe('session-3');
    expect(prisma.refreshToken.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        audience: 'APP',
        expiredAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-1');
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-2');
    expect(revocation.revokeSession).not.toHaveBeenCalledWith('session-3');
  });

  it('does not treat a single-device replacement token as reuse', async () => {
    const { token: oldToken } = await service.create('user-1');
    const replacement = await service.replaceForSingleDevice(
      'user-1',
      { deviceName: 'replacement' },
      'APP',
    );
    jest.clearAllMocks();

    await expect(service.rotate(oldToken)).rejects.toThrow(
      /invalid or expired refresh token/i,
    );

    expect(
      records.find((record) => record.id === replacement.sessionId)?.revokedAt,
    ).toBeNull();
    expect(revocation.revokeUser).not.toHaveBeenCalled();
    expect(revocation.revokeSession).not.toHaveBeenCalled();
  });

  it('limits rotated-token reuse response to the compromised token family', async () => {
    const { token: oldToken } = await service.create('user-1');
    const rotated = await service.rotate(oldToken);
    const admin = await service.create('user-1', undefined, 'ADMIN');
    jest.clearAllMocks();

    await expect(service.rotate(oldToken)).rejects.toThrow(/reuse detected/i);

    expect(
      records.find((record) => record.id === rotated.sessionId)?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      records.find((record) => record.id === admin.sessionId)?.revokedAt,
    ).toBeNull();
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-1');
    expect(revocation.revokeSession).toHaveBeenCalledWith(rotated.sessionId);
    expect(revocation.revokeSession).not.toHaveBeenCalledWith(admin.sessionId);
    expect(revocation.revokeUser).not.toHaveBeenCalled();
  });

  it('revokes live access sessions for reused families even when refresh rows predate the current access TTL', async () => {
    const { token: oldToken } = await service.create('user-1');
    const rotated = await service.rotate(oldToken);
    records.find((record) => record.id === rotated.sessionId)!.createdAt =
      new Date(Date.now() - 60 * 60 * 1000);
    jest.clearAllMocks();

    await expect(service.rotate(oldToken)).rejects.toThrow(/reuse detected/i);

    expect(revocation.revokeSession).toHaveBeenCalledWith(rotated.sessionId);
  });

  it('rejects an expired rotated token without revoking its family again', async () => {
    const { token: oldToken } = await service.create('user-1');
    const rotated = await service.rotate(oldToken);
    records[0].expiredAt = new Date(Date.now() - 1);
    jest.clearAllMocks();

    await expect(service.rotate(oldToken)).rejects.toThrow(
      /invalid or expired refresh token/i,
    );

    expect(
      records.find((record) => record.id === rotated.sessionId)?.revokedAt,
    ).toBeNull();
    expect(revocation.revokeSession).not.toHaveBeenCalled();
    expect(revocation.revokeUser).not.toHaveBeenCalled();
  });

  it('keeps ADMIN sessions when replacing APP single-device sessions', async () => {
    const admin = await service.create('user-1', undefined, 'ADMIN');
    await service.create('user-1', undefined, 'APP');
    jest.clearAllMocks();

    await service.replaceForSingleDevice('user-1', undefined, 'APP');

    expect(
      records.find((record) => record.id === admin.sessionId)?.revokedAt,
    ).toBeNull();
    expect(revocation.revokeSession).not.toHaveBeenCalledWith(admin.sessionId);
  });

  it('marks every unexpired replaced session when access TTL may have been shortened', async () => {
    const configured = new RefreshTokenService(
      prisma as any,
      {
        get: jest.fn((key: string) =>
          key === 'JWT_EXPIRES_IN' ? '1h' : undefined,
        ),
      } as any,
      revocation as any,
    );
    const recent = new Date(Date.now() - 30 * 60 * 1000);
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const expired = new Date(Date.now() - 24 * 60 * 60 * 1000);
    records.push(
      {
        id: 'recent-rotated',
        userId: 'user-1',
        token: 'recent-token',
        audience: 'APP',
        familyId: 'recent-family',
        revocationReason: 'ROTATED',
        revokedAt: recent,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: recent,
        lastUsedAt: recent,
      },
      {
        id: 'stale-rotated',
        userId: 'user-1',
        token: 'stale-token',
        audience: 'APP',
        familyId: 'stale-family',
        revocationReason: 'ROTATED',
        revokedAt: stale,
        expiredAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        createdAt: stale,
        lastUsedAt: stale,
      },
      {
        id: 'expired-rotated',
        userId: 'user-1',
        token: 'expired-token',
        audience: 'APP',
        familyId: 'expired-family',
        revocationReason: 'ROTATED',
        revokedAt: expired,
        expiredAt: new Date(Date.now() - 60 * 1000),
        createdAt: expired,
        lastUsedAt: expired,
      },
    );

    await configured.replaceForSingleDevice('user-1');

    expect(prisma.refreshToken.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        audience: 'APP',
        expiredAt: { gt: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(revocation.revokeSession).toHaveBeenCalledWith('recent-rotated');
    expect(revocation.revokeSession).toHaveBeenCalledWith('stale-rotated');
    expect(revocation.revokeSession).not.toHaveBeenCalledWith(
      'expired-rotated',
    );
  });

  it('applies access revocation markers with bounded concurrency', async () => {
    const now = new Date();
    for (let index = 0; index < 30; index += 1) {
      records.push({
        id: `old-session-${index}`,
        userId: 'user-1',
        token: `old-token-${index}`,
        audience: 'APP',
        familyId: `family-${index}`,
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        lastUsedAt: now,
      });
    }
    let releaseMarkers!: () => void;
    const markerGate = new Promise<void>((resolve) => {
      releaseMarkers = resolve;
    });
    let activeMarkers = 0;
    let maxActiveMarkers = 0;
    revocation.revokeSession.mockImplementation(async () => {
      activeMarkers += 1;
      maxActiveMarkers = Math.max(maxActiveMarkers, activeMarkers);
      await markerGate;
      activeMarkers -= 1;
    });

    const replacement = service.replaceForSingleDevice('user-1');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(revocation.revokeSession).toHaveBeenCalledTimes(25);
    expect(maxActiveMarkers).toBe(25);

    releaseMarkers();
    await replacement;
    expect(revocation.revokeSession).toHaveBeenCalledTimes(30);
    expect(maxActiveMarkers).toBe(25);
  });

  it('bounds access marker concurrency when revoking other sessions', async () => {
    const now = new Date();
    records.push({
      id: 'current',
      userId: 'user-1',
      token: 'current-token',
      audience: 'APP',
      familyId: 'current-family',
      revokedAt: null,
      expiredAt: new Date(now.getTime() + 60 * 60 * 1000),
      createdAt: now,
      lastUsedAt: now,
    });
    for (let index = 0; index < 30; index += 1) {
      records.push({
        id: `other-${index}`,
        userId: 'user-1',
        token: `other-token-${index}`,
        audience: 'APP',
        familyId: `other-family-${index}`,
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 60 * 60 * 1000),
        createdAt: now,
        lastUsedAt: now,
      });
    }
    let releaseMarkers!: () => void;
    const markerGate = new Promise<void>((resolve) => {
      releaseMarkers = resolve;
    });
    revocation.revokeSession.mockImplementation(() => markerGate);

    const revoking = service.revokeOtherSessions('user-1', 'current');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const callsBeforeRelease = revocation.revokeSession.mock.calls.length;
    releaseMarkers();
    await revoking;

    expect(callsBeforeRelease).toBe(25);
    expect(revocation.revokeSession).toHaveBeenCalledTimes(30);
  });

  it('serializes APP session creation and setting changes with the same user lock', async () => {
    await service.create('user-1', { deviceName: 'old login' });
    prisma.$executeRaw.mockImplementationOnce(async () => {
      userSettings.set('user-1', true);
      return 0;
    });

    const session = await service.createAppSession('user-1', {
      deviceName: 'new login',
    });
    await service.setSingleDeviceLogin('user-1', false, session.sessionId);

    expect(session.sessionId).toBe('session-2');
    expect(records[0].revokedAt).toBeInstanceOf(Date);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { singleDeviceLoginEnabled: true },
    });
    expect(userSettings.get('user-1')).toBe(false);
  });

  it('revokes other ADMIN sessions when enabling single-device login', async () => {
    const admin = await service.create('user-1', undefined, 'ADMIN');
    const current = await service.create('user-1', undefined, 'APP');
    const otherApp = await service.create('user-1', undefined, 'APP');
    jest.clearAllMocks();

    await service.setSingleDeviceLogin('user-1', true, current.sessionId);

    expect(
      records.find((record) => record.id === current.sessionId)?.revokedAt,
    ).toBeNull();
    expect(
      records.find((record) => record.id === admin.sessionId)?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(
      records.find((record) => record.id === otherApp.sessionId)?.revokedAt,
    ).toBeInstanceOf(Date);
    expect(revocation.revokeSession).toHaveBeenCalledWith(admin.sessionId);
    expect(revocation.revokeSession).toHaveBeenCalledWith(otherApp.sessionId);
    expect(revocation.revokeSession).not.toHaveBeenCalledWith(
      current.sessionId,
    );
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
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
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

  it('marks legacy revoked refresh-token replays with null revocation reason', async () => {
    const { token: raw } = await service.create('user-1');
    await service.rotate(raw);
    records[0].revocationReason = null;
    jest.clearAllMocks();

    await expect(service.rotate(raw)).rejects.toThrow(/reuse detected/i);

    expect(revocation.revokeSession).toHaveBeenCalledWith('session-1');
  });

  it('creates ADMIN sessions under the single-device lock and rechecks the setting', async () => {
    await service.create('user-1', { deviceName: 'old admin' }, 'ADMIN');
    prisma.$executeRaw.mockImplementationOnce(async () => {
      userSettings.set('user-1', true);
      return 0;
    });

    const session = await (
      service as any
    ).createSessionForCurrentSingleDeviceSetting(
      'user-1',
      { deviceName: 'new admin' },
      'ADMIN',
    );

    expect(session.sessionId).toBe('session-2');
    expect(records[0].revokedAt).toBeInstanceOf(Date);
    expect(records[1].audience).toBe('ADMIN');
    expect(records[1].deviceName).toBe('new admin');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { singleDeviceLoginEnabled: true },
    });
    expect(revocation.revokeSession).toHaveBeenCalledWith('session-1');
  });

  it('rejects rotating an unknown refresh token', async () => {
    await expect(service.rotate('missing-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
