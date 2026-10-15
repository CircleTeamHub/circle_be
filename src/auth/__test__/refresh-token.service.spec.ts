import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshTokenService } from '../refresh-token.service';
import { SessionRevocationService } from '../session-revocation.service';
import { SessionVerifier } from '../session-verifier.service';
import { jobMetrics } from '../../metrics/job-metrics';

function metricValue(
  text: string,
  name: string,
  labels: Record<string, string>,
): number {
  const renderedLabels = Object.entries(labels)
    .map(([key, value]) => `${key}="${value}"`)
    .join(',');
  const prefix = `${name}{${renderedLabels}} `;
  const line = text
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix));
  return line ? Number(line.slice(prefix.length)) : 0;
}

describe('RefreshTokenService', () => {
  let service: RefreshTokenService;

  const records: any[] = [];
  const userSettings = new Map<string, boolean>();
  const scopeGenerations = new Map<string, any>();
  const loopbackIp = ['127', '0', '0', '1'].join('.');
  const privateIp = ['10', '0', '0', '1'].join('.');

  const matchesWhere = (record: any, where: any): boolean => {
    if (!where) return true;
    if (
      where.AND &&
      !where.AND.every((part: any) => matchesWhere(record, part))
    ) {
      return false;
    }
    if (where.OR && !where.OR.some((part: any) => matchesWhere(record, part))) {
      return false;
    }
    for (const field of ['userId', 'token', 'audience', 'deviceKey']) {
      if (where[field] !== undefined && record[field] !== where[field])
        return false;
    }
    if (typeof where.id === 'string' && record.id !== where.id) return false;
    if (where.id?.not !== undefined && record.id === where.id.not) return false;
    if (where.id?.in !== undefined && !where.id.in.includes(record.id))
      return false;
    if (where.id?.gt !== undefined && record.id <= where.id.gt) return false;
    if (
      typeof where.familyId === 'string' &&
      record.familyId !== where.familyId
    ) {
      return false;
    }
    if (
      where.familyId?.not !== undefined &&
      record.familyId === where.familyId.not
    ) {
      return false;
    }
    for (const field of [
      'revokedAt',
      'accessRevokedAt',
      'accessRevocationNotifiedAt',
      'accessRevocationLockedAt',
    ]) {
      if (where[field] === null && record[field] != null) return false;
      if (where[field]?.not === null && record[field] == null) return false;
      if (where[field] instanceof Date) {
        if (!(record[field] instanceof Date)) return false;
        if (record[field].getTime() !== where[field].getTime()) return false;
      }
    }
    if (
      where.accessRevocationLeaseToken !== undefined &&
      record.accessRevocationLeaseToken !== where.accessRevocationLeaseToken
    ) {
      return false;
    }
    for (const field of [
      'expiredAt',
      'createdAt',
      'accessTokenExpiresAt',
      'accessRevocationLockedAt',
    ]) {
      const filter = where[field];
      if (filter === null && record[field] != null) return false;
      if (
        filter?.gt &&
        (!(record[field] instanceof Date) || record[field] <= filter.gt)
      )
        return false;
      if (filter?.lte && record[field] > filter.lte) return false;
    }
    return true;
  };

  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn(async (callback) =>
      Array.isArray(callback) ? Promise.all(callback) : callback(prisma),
    ),
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
          accessRevokedAt: null,
          accessRevocationNotifiedAt: null,
          accessRevocationLockedAt: null,
          accessRevocationLeaseToken: null,
          accessTokenExpiresAt: null,
          ...data,
        };
        records.push(record);
        return record;
      }),
      findUnique: jest.fn(({ where }) =>
        Promise.resolve(
          records.find((record) =>
            where.id ? record.id === where.id : record.token === where.token,
          ) ?? null,
        ),
      ),
      findFirst: jest.fn(({ where }) =>
        Promise.resolve(
          records.find((record) => matchesWhere(record, where)) ?? null,
        ),
      ),
      findMany: jest.fn(({ where, orderBy, take }) => {
        const matching = records.filter((record) =>
          matchesWhere(record, where),
        );
        if (orderBy?.id === 'asc') {
          matching.sort((left, right) => left.id.localeCompare(right.id));
        }
        return Promise.resolve(
          typeof take === 'number' ? matching.slice(0, take) : matching,
        );
      }),
      update: jest.fn(async ({ where, data }) => {
        const record = records.find((item) => item.id === where.id);
        Object.assign(record, data);
        return record;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const matching = records.filter((record) =>
          matchesWhere(record, where),
        );
        matching.forEach((record) => Object.assign(record, data));
        return { count: matching.length };
      }),
      updateManyAndReturn: jest.fn(async ({ where, data }) => {
        const matching = records.filter((record) =>
          matchesWhere(record, where),
        );
        matching.forEach((record) => Object.assign(record, data));
        return matching.map(({ id }) => ({ id }));
      }),
    },
    sessionScopeGeneration: {
      findMany: jest.fn(({ where }) =>
        Promise.resolve(
          [...scopeGenerations.values()].filter((row) => {
            if (where.userId !== undefined && row.userId !== where.userId) {
              return false;
            }
            if (
              where.notificationPending !== undefined &&
              row.notificationPending !== where.notificationPending
            ) {
              return false;
            }
            return (
              !where.OR ||
              where.OR.some(
                (scope: any) =>
                  (scope.userId === undefined || scope.userId === row.userId) &&
                  (scope.scope === undefined || scope.scope === row.scope) &&
                  (scope.scopeKey === undefined ||
                    scope.scopeKey === row.scopeKey) &&
                  (scope.generation === undefined ||
                    scope.generation === row.generation),
              )
            );
          }),
        ),
      ),
      upsert: jest.fn(async ({ where, create, update }) => {
        const key = `${where.userId_scope_scopeKey.userId}:${where.userId_scope_scopeKey.scope}:${where.userId_scope_scopeKey.scopeKey}`;
        const existing = scopeGenerations.get(key);
        const row = existing
          ? {
              ...existing,
              generation:
                existing.generation + (update.generation?.increment ?? 0),
              exemptFamilyId: update.exemptFamilyId,
              notificationPending: update.notificationPending,
            }
          : { ...create };
        scopeGenerations.set(key, row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        let count = 0;
        for (const [key, row] of scopeGenerations) {
          const directMatch =
            (where.userId === undefined || where.userId === row.userId) &&
            (where.scope === undefined || where.scope === row.scope) &&
            (where.scopeKey === undefined || where.scopeKey === row.scopeKey) &&
            (where.generation === undefined ||
              where.generation === row.generation) &&
            (where.notificationPending === undefined ||
              where.notificationPending === row.notificationPending);
          const orMatch =
            !where.OR ||
            where.OR.some(
              (candidate: any) =>
                candidate.userId === row.userId &&
                candidate.scope === row.scope &&
                candidate.scopeKey === row.scopeKey &&
                candidate.generation === row.generation,
            );
          if (directMatch && orMatch) {
            scopeGenerations.set(key, { ...row, ...data });
            count += 1;
          }
        }
        return { count };
      }),
    },
  };

  const config = { get: jest.fn().mockReturnValue(undefined) };
  const revocation = {
    revokeUser: jest.fn().mockResolvedValue(undefined),
    revokeSession: jest.fn().mockResolvedValue(undefined),
    revokeScope: jest.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    records.length = 0;
    userSettings.clear();
    scopeGenerations.clear();
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

  // GET /auth/sessions 此前不设上限。按最近使用从新到旧，同一时刻再按创建时间、
  // id 兜底，保证每次返回同一个顺序、同一批前 100 条。
  it('lists at most 100 active sessions, most recently used first with a stable tie-break', async () => {
    await service.listActiveSessions('user-1');

    expect(prisma.refreshToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: 'user-1', revokedAt: null }),
        orderBy: [
          { lastUsedAt: 'desc' },
          { createdAt: 'desc' },
          { id: 'desc' },
        ],
        take: 100,
      }),
    );
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

  it('durably revokes rotated ancestors when removing the current session family', async () => {
    const { token, sessionId: ancestorSessionId } = await service.create(
      'user-1',
      { deviceKey: 'device-a' },
    );
    const current = await service.rotate(token);
    jest.clearAllMocks();

    await service.revokeSessionFamily('user-1', current.sessionId);

    const ancestor = records.find((record) => record.id === ancestorSessionId);
    const currentRecord = records.find(
      (record) => record.id === current.sessionId,
    );
    expect(ancestor).toMatchObject({
      revocationReason: 'ROTATED',
      accessRevokedAt: null,
    });
    expect(currentRecord).toMatchObject({
      revocationReason: 'SESSION_REVOKED',
      accessRevokedAt: null,
    });
    expect(revocation.revokeScope).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'FAMILY' }),
    );

    const verifier = new SessionVerifier(
      { checkRevocation: jest.fn().mockResolvedValue('unknown') } as any,
      {
        user: {
          findUnique: jest.fn().mockResolvedValue({
            status: 'ACTIVE',
            accessTokensRevokedAt: null,
          }),
        },
        refreshToken: {
          findUnique: jest.fn(({ where }) =>
            Promise.resolve(
              records.find((record) => record.id === where.id) ?? null,
            ),
          ),
        },
        sessionScopeGeneration: prisma.sessionScopeGeneration,
      } as any,
    );
    await expect(
      verifier.verify({ sub: 'user-1', sid: ancestorSessionId }),
    ).resolves.toBe('revoked');
  });

  it('revokes a rotated family by incrementing one scope generation without rewriting history', async () => {
    const { token, sessionId: ancestorSessionId } = await service.create(
      'user-1',
      { deviceKey: 'device-a' },
    );
    const current = await service.rotate(token);
    jest.clearAllMocks();

    await service.revokeSessionFamily('user-1', current.sessionId);

    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_scope_scopeKey: {
            userId: 'user-1',
            scope: 'FAMILY',
            scopeKey: records[0].familyId,
          },
        },
      }),
    );
    expect(
      records.find(({ id }) => id === ancestorSessionId).accessRevokedAt,
    ).toBeNull();
    expect(revocation.revokeScope).toHaveBeenCalledWith({
      userId: 'user-1',
      scope: 'FAMILY',
      scopeKey: records[0].familyId,
      exemptFamilyId: null,
    });
  });

  it('revokes all active sessions except the current session', async () => {
    const now = new Date();
    records.push(
      {
        id: 'current',
        userId: 'user-1',
        token: 'token-1',
        familyId: 'current-family',
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
      },
      {
        id: 'other',
        userId: 'user-1',
        token: 'token-2',
        familyId: 'other-family',
        revokedAt: null,
        expiredAt: new Date(now.getTime() + 1000 * 60),
        createdAt: now,
        lastUsedAt: now,
      },
    );

    await service.revokeOtherSessions('user-1', 'current');

    expect(records[0].revokedAt).toBeNull();
    expect(records[1].revokedAt).toBeInstanceOf(Date);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(revocation.revokeScope).toHaveBeenCalledWith({
      userId: 'user-1',
      scope: 'ACCOUNT',
      scopeKey: '*',
      exemptFamilyId: 'current-family',
    });
  });

  it('revokes access tokens for rotated sessions when removing a device', async () => {
    const { token } = await service.create('user-1', {
      deviceKey: 'device-a',
    });
    await service.rotate(token);
    await service.create('user-1', { deviceKey: 'device-b' });
    jest.clearAllMocks();

    await service.revokeDeviceSessions('user-1', 'device-a');

    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledTimes(1);
    expect(revocation.revokeScope).toHaveBeenCalledWith({
      userId: 'user-1',
      scope: 'DEVICE',
      scopeKey: 'device-a',
      exemptFamilyId: null,
    });
    expect(records[0].accessRevokedAt).toBeNull();
    expect(records[1].accessRevokedAt).toBeNull();
    expect(records[0].accessTokenExpiresAt).toBeNull();
    expect(records[0].expiredAt.getTime()).toBeGreaterThan(Date.now() - 1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledWith(
      expect.anything(),
      'auth-user:user-1',
    );
  });

  it('revokes rotated access tokens when logging out other sessions', async () => {
    const current = await service.create('user-1', {
      deviceKey: 'device-current',
    });
    const { token: otherToken } = await service.create('user-1', {
      deviceKey: 'device-other',
    });
    await service.rotate(otherToken);
    jest.clearAllMocks();

    await service.revokeOtherSessions('user-1', current.sessionId);

    expect(revocation.revokeScope).toHaveBeenCalledWith({
      userId: 'user-1',
      scope: 'ACCOUNT',
      scopeKey: '*',
      exemptFamilyId: records.find(({ id }) => id === current.sessionId)
        ?.familyId,
    });
    expect(records[1].accessRevokedAt).toBeNull();
    expect(records[2].accessRevokedAt).toBeNull();
  });

  it('preserves every SID in the current token family when logging out other sessions', async () => {
    const { token: currentToken, sessionId: currentOldSid } =
      await service.create('user-1', { deviceKey: 'device-current' });
    const current = await service.rotate(currentToken);
    const { token: otherToken, sessionId: otherOldSid } = await service.create(
      'user-1',
      { deviceKey: 'device-other' },
    );
    const other = await service.rotate(otherToken);
    jest.clearAllMocks();

    await service.revokeOtherSessions('user-1', currentOldSid);

    expect(revocation.revokeScope).toHaveBeenCalledWith({
      userId: 'user-1',
      scope: 'ACCOUNT',
      scopeKey: '*',
      exemptFamilyId: records.find(({ id }) => id === currentOldSid)?.familyId,
    });
    expect(
      records.find((record) => record.id === currentOldSid)?.accessRevokedAt,
    ).toBeNull();
    expect(
      records.find((record) => record.id === current.sessionId)?.revokedAt,
    ).toBeNull();
    expect(
      records.find((record) => record.id === otherOldSid)?.accessRevokedAt,
    ).toBeNull();
    expect(
      records.find((record) => record.id === other.sessionId)?.revokedAt,
    ).toBeInstanceOf(Date);
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
    revocation.revokeScope.mockImplementationOnce(() => {
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
    expect(revocation.revokeScope).toHaveBeenCalledTimes(2);
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
    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledTimes(1);
    expect(revocation.revokeScope).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        scope: 'AUDIENCE',
        scopeKey: 'APP',
      }),
    );
    expect(records[0].accessRevokedAt).toBeNull();
    expect(records[1].accessRevokedAt).toBeNull();
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

  it('revokes legacy rotated access tokens through one audience generation', async () => {
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

    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledTimes(1);
    expect(revocation.revokeScope).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'AUDIENCE', scopeKey: 'APP' }),
    );
    expect(records.every((record) => record.accessRevokedAt == null)).toBe(
      true,
    );
  });

  it('does one generation write regardless of rotation history length', async () => {
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
    await service.replaceForSingleDevice('user-1');

    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledTimes(1);
    expect(revocation.revokeScope).toHaveBeenCalledTimes(1);
    expect(revocation.revokeSession).not.toHaveBeenCalled();
    expect(
      records
        .slice(0, 30)
        .every(({ accessRevokedAt }) => accessRevokedAt == null),
    ).toBe(true);
  });

  it('keeps logout-other generation work constant with many sessions', async () => {
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
    for (let index = 0; index < 130; index += 1) {
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
    await service.revokeOtherSessions('user-1', 'current');

    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledTimes(1);
    expect(revocation.revokeScope).toHaveBeenCalledTimes(1);
    expect(revocation.revokeSession).not.toHaveBeenCalled();
    expect(
      records.slice(1).every(({ accessRevokedAt }) => accessRevokedAt == null),
    ).toBe(true);
  });

  it('keeps durable generation revocation when realtime broadcast is not delivered', async () => {
    await service.create('user-1', { deviceKey: 'device-a' });
    revocation.revokeScope.mockResolvedValueOnce(false);

    await service.revokeDeviceSessions('user-1', 'device-a');

    expect(records[0].revokedAt).toBeInstanceOf(Date);
    expect(prisma.sessionScopeGeneration.upsert).toHaveBeenCalledTimes(1);
    expect(scopeGenerations.get('user-1:DEVICE:device-a')?.generation).toBe(1);
    expect(
      scopeGenerations.get('user-1:DEVICE:device-a')?.notificationPending,
    ).toBe(true);

    revocation.revokeScope.mockResolvedValueOnce(true);
    await service.flushPendingAccessRevocations();

    expect(revocation.revokeScope).toHaveBeenCalledTimes(2);
    expect(
      scopeGenerations.get('user-1:DEVICE:device-a')?.notificationPending,
    ).toBe(false);
  });

  it('keeps device trust revocation reachable when immediate outbox delivery fails', async () => {
    await service.create('user-1', { deviceKey: 'device-a' });
    revocation.revokeScope.mockRejectedValueOnce(
      new Error('redis temporarily unavailable'),
    );

    await expect(
      service.revokeDeviceSessions('user-1', 'device-a'),
    ).resolves.toBeUndefined();

    expect(records[0]).toMatchObject({
      revokedAt: expect.any(Date),
      accessRevokedAt: null,
      accessRevocationNotifiedAt: null,
    });
    expect(scopeGenerations.get('user-1:DEVICE:device-a')?.generation).toBe(1);
  });

  it('keeps other-device trust revocation reachable when immediate outbox delivery fails', async () => {
    const current = await service.create('user-1', { deviceKey: 'device-a' });
    await service.create('user-1', { deviceKey: 'device-b' });
    revocation.revokeScope.mockRejectedValueOnce(
      new Error('redis temporarily unavailable'),
    );

    await expect(
      service.revokeOtherSessions('user-1', current.sessionId),
    ).resolves.toBeUndefined();

    expect(records[0].revokedAt).toBeNull();
    expect(records[1]).toMatchObject({
      revokedAt: expect.any(Date),
      accessRevokedAt: null,
      accessRevocationNotifiedAt: null,
    });
  });

  it('reports an unavailable outbox delivery as a tracked job failure', async () => {
    const now = new Date();
    records.push({
      id: 'pending-revocation',
      userId: 'user-1',
      token: 'pending-token',
      audience: 'APP',
      familyId: 'pending-family',
      revokedAt: now,
      accessRevokedAt: now,
      accessRevocationNotifiedAt: null,
      accessRevocationLockedAt: null,
      accessRevocationLeaseToken: null,
      accessTokenExpiresAt: new Date(now.getTime() + 60_000),
      expiredAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      lastUsedAt: now,
    });
    revocation.revokeSession.mockResolvedValue(false);
    const before = await jobMetrics.registry.metrics();
    const failuresBefore = metricValue(before, 'circle_cron_runs_total', {
      job: 'access_revocation_outbox',
      result: 'failure',
    });

    await service.flushPendingAccessRevocations();

    const after = await jobMetrics.registry.metrics();
    expect(
      metricValue(after, 'circle_cron_runs_total', {
        job: 'access_revocation_outbox',
        result: 'failure',
      }),
    ).toBe(failuresBefore + 1);
    expect(records[0].accessRevocationNotifiedAt).toBeNull();
  });

  it('reports an overlapping outbox sweep as skipped without advancing success', async () => {
    (service as any).accessRevocationSweepRunning = true;
    const before = await jobMetrics.registry.metrics();
    const skippedBefore = metricValue(before, 'circle_cron_runs_total', {
      job: 'access_revocation_outbox',
      result: 'skipped',
    });
    const successBefore = metricValue(
      before,
      'circle_cron_last_success_timestamp_seconds',
      { job: 'access_revocation_outbox' },
    );
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

    await service.flushPendingAccessRevocations();

    nowSpy.mockRestore();
    const after = await jobMetrics.registry.metrics();
    expect(
      metricValue(after, 'circle_cron_runs_total', {
        job: 'access_revocation_outbox',
        result: 'skipped',
      }),
    ).toBe(skippedBefore + 1);
    expect(
      metricValue(after, 'circle_cron_last_success_timestamp_seconds', {
        job: 'access_revocation_outbox',
      }),
    ).toBe(successBefore);
  });

  it('claims each pending SID once across concurrent outbox processors', async () => {
    const now = new Date();
    records.push({
      id: 'shared-pending-revocation',
      userId: 'user-1',
      token: 'shared-pending-token',
      audience: 'APP',
      familyId: 'shared-pending-family',
      revokedAt: now,
      accessRevokedAt: now,
      accessRevocationNotifiedAt: null,
      accessRevocationLockedAt: null,
      accessRevocationLeaseToken: null,
      accessTokenExpiresAt: new Date(now.getTime() + 60_000),
      expiredAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      lastUsedAt: now,
    });
    const second = new RefreshTokenService(
      prisma as any,
      config as any,
      revocation as any,
    );
    let release!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    revocation.revokeSession.mockImplementation(() => deliveryGate);

    const firstRun = service.flushPendingAccessRevocations();
    const secondRun = second.flushPendingAccessRevocations();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(revocation.revokeSession).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([firstRun, secondRun]);
    expect(records[0].accessRevocationNotifiedAt).toBeInstanceOf(Date);
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

  it('returns the committed replacement session after generation broadcast succeeds', async () => {
    await service.create('user-1', { deviceName: 'old login' });
    userSettings.set('user-1', true);

    await expect(
      service.createAppSession('user-1', { deviceName: 'new login' }),
    ).resolves.toMatchObject({
      token: expect.any(String),
      sessionId: 'session-2',
    });

    expect(records[0]).toMatchObject({
      revokedAt: expect.any(Date),
      accessRevokedAt: null,
      accessRevocationNotifiedAt: null,
    });
    expect(revocation.revokeScope).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'AUDIENCE', scopeKey: 'APP' }),
    );
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
    expect(revocation.revokeScope).toHaveBeenCalledWith({
      userId: 'user-1',
      scope: 'ACCOUNT',
      scopeKey: '*',
      exemptFamilyId: records.find(({ id }) => id === current.sessionId)
        ?.familyId,
    });
  });

  it('durably revokes rotated prior devices while preserving the current family', async () => {
    const { token: currentToken } = await service.create('user-1');
    const current = await service.rotate(currentToken);
    const { token: otherToken, sessionId: otherOldSid } =
      await service.create('user-1');
    const other = await service.rotate(otherToken);
    jest.clearAllMocks();

    await service.setSingleDeviceLogin('user-1', true, current.sessionId);

    expect(records[0].accessRevokedAt).toBeNull();
    expect(records[1].accessRevokedAt).toBeNull();
    expect(
      records.find((record) => record.id === otherOldSid)?.accessRevokedAt,
    ).toBeNull();
    expect(
      records.find((record) => record.id === other.sessionId)?.accessRevokedAt,
    ).toBeNull();
    expect(revocation.revokeScope).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'ACCOUNT',
        exemptFamilyId: records.find(({ id }) => id === current.sessionId)
          ?.familyId,
      }),
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
    expect(revocation.revokeScope).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'AUDIENCE', scopeKey: 'ADMIN' }),
    );
  });

  it('rejects rotating an unknown refresh token', async () => {
    await expect(service.rotate('missing-token')).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
