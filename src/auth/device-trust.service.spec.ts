import { AsyncLocalStorage } from 'node:async_hooks';
jest.mock('argon2', () => {
  const actual = jest.requireActual('argon2');
  return {
    __esModule: true,
    ...actual,
    hash: jest.fn(actual.hash),
    verify: jest.fn(actual.verify),
  };
});
import * as argon2 from 'argon2';
import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import {
  DeviceTrustService,
  hashDeviceId,
  LOGIN_CHALLENGE_CODE_TTL_MS,
  LOGIN_CHALLENGE_DECISION_MS,
  LOGIN_CHALLENGE_MAX_ATTEMPTS,
  LOGIN_CHALLENGE_ACCOUNT_RATE_LIMIT,
  LOGIN_CHALLENGE_RATE_LIMIT,
  LOGIN_CHALLENGE_SECURITY_CODE_DAILY_FAILURES,
} from './device-trust.service';

type Trusted = {
  userId: string;
  deviceKey: string;
  deviceName: string | null;
  lastIp: string | null;
  revokedAt: Date | null;
  lastSeenAt: Date;
};

type Challenge = {
  id: string;
  userId: string;
  deviceKey: string;
  deviceName: string | null;
  ip: string | null;
  userAgent: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CONSUMED';
  codeHash: string | null;
  codeExpiresAt: Date | null;
  attempts: number;
  expiresAt: Date;
  decidedAt: Date | null;
  createdAt: Date;
};

function matches(row: Record<string, unknown>, where: Record<string, any>) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(value);
      if ('gt' in cond) return (value as any) > cond.gt;
      if ('lt' in cond) return (value as any) < cond.lt;
      if ('lte' in cond) return (value as any) <= cond.lte;
      if ('not' in cond) return value !== cond.not;
    }
    return value === cond;
  });
}

function setup() {
  const trusted: Trusted[] = [];
  const challenges: Challenge[] = [];
  let seq = 0;
  const users: Record<string, { loginSecurityCodeHash: string | null }> = {
    u1: { loginSecurityCodeHash: null },
  };
  const liveSessions = { count: 0 };

  const prisma = {
    trustedDevice: {
      findUnique: jest.fn(async ({ where }) => {
        const { userId, deviceKey } = where.userId_deviceKey;
        return (
          trusted.find(
            (t) => t.userId === userId && t.deviceKey === deviceKey,
          ) ?? null
        );
      }),
      count: jest.fn(
        async ({ where }) =>
          trusted.filter((t) => matches(t as any, where)).length,
      ),
      create: jest.fn(async ({ data }) => {
        trusted.push({ revokedAt: null, ...data });
      }),
      upsert: jest.fn(async ({ where, create, update }) => {
        const { userId, deviceKey } = where.userId_deviceKey;
        const row = trusted.find(
          (t) => t.userId === userId && t.deviceKey === deviceKey,
        );
        if (row) Object.assign(row, update);
        else trusted.push({ revokedAt: null, ...create });
      }),
      update: jest.fn(async ({ where, data }) => {
        const { userId, deviceKey } = where.userId_deviceKey;
        const row = trusted.find(
          (t) => t.userId === userId && t.deviceKey === deviceKey,
        )!;
        Object.assign(row, data);
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = trusted.filter((t) => matches(t as any, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      }),
    },
    loginChallenge: {
      findFirst: jest.fn(async ({ where }) => {
        const rows = challenges
          .filter((c) => matches(c as any, where))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return rows[0] ?? null;
      }),
      findUnique: jest.fn(async ({ where }) => {
        const row = challenges.find((c) => c.id === where.id);
        return row ? { ...row } : null;
      }),
      findMany: jest.fn(async ({ where }) =>
        challenges.filter((c) => matches(c as any, where)),
      ),
      count: jest.fn(
        async ({ where }) =>
          challenges.filter((c) => matches(c as any, where)).length,
      ),
      create: jest.fn(async ({ data }) => {
        const row: Challenge = {
          id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
          status: 'PENDING',
          codeHash: null,
          codeExpiresAt: null,
          attempts: 0,
          decidedAt: null,
          createdAt: new Date(),
          deviceName: null,
          ip: null,
          userAgent: null,
          ...data,
        };
        challenges.push(row);
        return { id: row.id, expiresAt: row.expiresAt };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const rows = challenges.filter((c) => matches(c as any, where));
        rows.forEach((r) => {
          const next = { ...data };
          if (next.attempts && typeof next.attempts === 'object') {
            next.attempts =
              r.attempts +
              (next.attempts.increment ?? -next.attempts.decrement);
          }
          Object.assign(r, next);
        });
        return { count: rows.length };
      }),
      updateManyAndReturn: jest.fn(async ({ where, data, select }) => {
        const rows = challenges.filter((c) => matches(c as any, where));
        rows.forEach((r) => {
          const next = { ...data };
          if (next.attempts && typeof next.attempts === 'object') {
            next.attempts =
              r.attempts +
              (next.attempts.increment ?? -next.attempts.decrement);
          }
          Object.assign(r, next);
        });
        return rows.map((r) =>
          Object.fromEntries(
            Object.keys(select ?? { id: true }).map((key) => [
              key,
              (r as Record<string, unknown>)[key],
            ]),
          ),
        );
      }),
      aggregate: jest.fn(async ({ where }) => ({
        _sum: {
          attempts: challenges
            .filter((c) => matches(c as any, where))
            .reduce((sum, c) => sum + c.attempts, 0),
        },
      })),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    user: {
      findUnique: jest.fn(async ({ where }) => users[where.id] ?? null),
    },
    refreshToken: {
      count: jest.fn(async () => liveSessions.count),
    },
  };
  let serial = Promise.resolve();
  const transactionScope = new AsyncLocalStorage<boolean>();
  (prisma as any).$queryRaw = jest.fn().mockResolvedValue([]);
  (prisma as any).$transaction = jest.fn((fn) => {
    if (transactionScope.getStore()) return fn(prisma);
    const next = serial.then(() =>
      transactionScope.run(true, () => fn(prisma)),
    );
    serial = next.catch(() => undefined);
    return next;
  });
  const realtime = { broadcast: jest.fn() };
  const push = {
    listActiveTokens: jest.fn(async () => [{ token: 't', projectId: null }]),
    sendToTokens: jest.fn(async () => []),
  };
  const service = new DeviceTrustService(
    prisma as never,
    realtime as never,
    push as never,
  );
  const trust = (deviceKey: string, userId = 'u1') =>
    trusted.push({
      userId,
      deviceKey,
      deviceName: null,
      lastIp: null,
      revokedAt: null,
      lastSeenAt: new Date(),
    });
  return {
    service,
    prisma,
    realtime,
    push,
    trusted,
    challenges,
    users,
    trust,
    liveSessions,
  };
}

const user = { id: 'u1', loginSecurityCodeHash: null };

describe('hashDeviceId', () => {
  it('hashes well-formed ids and rejects anything else', () => {
    const id = 'a1B2c3D4e5F6g7H8i9J0';
    expect(hashDeviceId(id)).toBe(
      createHash('sha256').update(id).digest('hex'),
    );
    expect(hashDeviceId('short')).toBeNull();
    expect(hashDeviceId('has spaces in it 1234')).toBeNull();
    expect(hashDeviceId(undefined)).toBeNull();
  });
});

describe('DeviceTrustService.evaluateLogin', () => {
  it('lets a trusted device straight in', async () => {
    const { service, trust, challenges } = setup();
    trust('phone');
    await expect(
      service.evaluateLogin(user, { deviceKey: 'phone' }),
    ).resolves.toEqual({ kind: 'trusted' });
    expect(challenges).toHaveLength(0);
  });

  it('trusts the first device of an account with no trusted devices', async () => {
    const { service, trusted } = setup();
    await expect(
      service.evaluateLogin(user, { deviceKey: 'first', deviceName: 'iPhone' }),
    ).resolves.toEqual({ kind: 'trusted' });
    expect(trusted).toEqual([
      expect.objectContaining({ deviceKey: 'first', revokedAt: null }),
    ]);
  });

  it('does not treat a revoked device as trusted', async () => {
    const { service, trusted, trust } = setup();
    trust('phone');
    trust('old');
    trusted[1].revokedAt = new Date();
    const decision = await service.evaluateLogin(user, { deviceKey: 'old' });
    expect(decision.kind).toBe('challenge');
  });

  it('creates a challenge for an unknown device and notifies trusted devices', async () => {
    const { service, trust, challenges, realtime, push } = setup();
    trust('phone');
    const decision = await service.evaluateLogin(user, {
      deviceKey: 'stranger',
      deviceName: 'Pixel 9',
      ip: '1.2.3.4',
    });
    expect(decision).toEqual({
      kind: 'challenge',
      challenge: {
        id: challenges[0].id,
        expiresAt: challenges[0].expiresAt,
        securityCodeAvailable: false,
      },
    });
    const window = challenges[0].expiresAt.getTime() - Date.now();
    expect(window).toBeGreaterThan(LOGIN_CHALLENGE_DECISION_MS - 5_000);
    expect(realtime.broadcast).toHaveBeenCalledWith('u1', {
      type: 'auth.login.challenge.created',
      payload: expect.objectContaining({ challengeId: challenges[0].id }),
    });
    await new Promise((r) => setImmediate(r));
    expect(push.sendToTokens).toHaveBeenCalled();
  });

  it('reuses the open challenge when the same device retries', async () => {
    const { service, trust, challenges, realtime } = setup();
    trust('phone');
    await service.evaluateLogin(user, { deviceKey: 'stranger' });
    await service.evaluateLogin(user, { deviceKey: 'stranger' });
    expect(challenges).toHaveLength(1);
    expect(realtime.broadcast).toHaveBeenCalledTimes(1);
  });

  it('rejects old clients without a device id once the account has trusted devices', async () => {
    const { service, trust } = setup();
    trust('phone');
    await expect(service.evaluateLogin(user, {})).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('rate-limits challenge creation per source IP without blocking other IPs', async () => {
    const { service, trust } = setup();
    trust('phone');
    for (let i = 0; i < LOGIN_CHALLENGE_RATE_LIMIT; i += 1) {
      await service.evaluateLogin(user, {
        deviceKey: `stranger-${i}`,
        ip: '198.51.100.1',
      });
    }
    await expect(
      service.evaluateLogin(user, {
        deviceKey: 'one-more',
        ip: '198.51.100.1',
      }),
    ).rejects.toThrow(HttpException);
    // 只知道密码的人刷满了自己的额度，本人从别的网络登录不受影响。
    await expect(
      service.evaluateLogin(user, { deviceKey: 'owner-new', ip: '192.0.2.9' }),
    ).resolves.toEqual(expect.objectContaining({ kind: 'challenge' }));
  });

  it('caps challenges per account across all IPs', async () => {
    const { service, trust } = setup();
    trust('phone');
    for (let i = 0; i < LOGIN_CHALLENGE_ACCOUNT_RATE_LIMIT; i += 1) {
      await service.evaluateLogin(user, {
        deviceKey: `stranger-${i}`,
        ip: `198.51.100.${i}`,
      });
    }
    await expect(
      service.evaluateLogin(user, { deviceKey: 'x', ip: '192.0.2.200' }),
    ).rejects.toThrow(HttpException);
  });

  it('does not auto-trust while the account still has live sessions (rollout window)', async () => {
    const { service, liveSessions, trusted } = setup();
    // 老账号：还没有任何信任记录，但本人手机上的旧会话还活着。
    liveSessions.count = 1;
    const decision = await service.evaluateLogin(user, {
      deviceKey: 'attacker',
    });
    expect(decision.kind).toBe('challenge');
    expect(trusted).toHaveLength(0);
  });
});

describe('DeviceTrustService approve / verify', () => {
  async function pending() {
    const ctx = setup();
    ctx.trust('phone');
    const decision = await ctx.service.evaluateLogin(user, {
      deviceKey: 'stranger',
    });
    if (decision.kind !== 'challenge') throw new Error('expected challenge');
    return { ...ctx, challengeId: decision.challenge.id };
  }

  it('only a trusted device can approve', async () => {
    const { service, challengeId } = await pending();
    await expect(
      service.approve('u1', 'stranger', challengeId),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.approve('u1', null, challengeId)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('approve returns a 6-digit code that expires in 60s and stores only a hash', async () => {
    const { service, challenges, challengeId } = await pending();
    const { code, codeExpiresAt } = await service.approve(
      'u1',
      'phone',
      challengeId,
    );
    expect(code).toMatch(/^\d{6}$/);
    expect(codeExpiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
      LOGIN_CHALLENGE_CODE_TTL_MS,
    );
    expect(challenges[0].status).toBe('APPROVED');
    expect(challenges[0].codeHash).not.toContain(code);
    expect(challenges[0].codeHash).toMatch(/^\$argon2id\$/);
    expect(challenges[0].codeHash).not.toBe(
      createHash('sha256').update(`${challengeId}:${code}`).digest('hex'),
    );
  });

  it('the new device logs in with the right code exactly once', async () => {
    const { service, challenges, challengeId } = await pending();
    const { code } = await service.approve('u1', 'phone', challengeId);
    await expect(
      service.consumeWithCode(challengeId, 'stranger', code),
    ).resolves.toEqual({ userId: 'u1', deviceKey: 'stranger' });
    expect(challenges[0].status).toBe('CONSUMED');
    await expect(
      service.consumeWithCode(challengeId, 'stranger', code),
    ).rejects.toThrow(NotFoundException);
  });

  it('a different device cannot use the challenge even with the code', async () => {
    const { service, challengeId } = await pending();
    const { code } = await service.approve('u1', 'phone', challengeId);
    await expect(
      service.consumeWithCode(challengeId, 'thief', code),
    ).rejects.toThrow(NotFoundException);
  });

  it('there is no code to enter before approval', async () => {
    const { service, challengeId } = await pending();
    await expect(
      service.consumeWithCode(challengeId, 'stranger', '000000'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('locks the challenge after too many wrong codes', async () => {
    const { service, challenges, challengeId } = await pending();
    const { code } = await service.approve('u1', 'phone', challengeId);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < LOGIN_CHALLENGE_MAX_ATTEMPTS; i += 1) {
      await expect(
        service.consumeWithCode(challengeId, 'stranger', wrong),
      ).rejects.toThrow(ForbiddenException);
    }
    expect(challenges[0].attempts).toBe(LOGIN_CHALLENGE_MAX_ATTEMPTS);
    await expect(
      service.consumeWithCode(challengeId, 'stranger', code),
    ).rejects.toThrow(/错误次数过多/);
  });

  it('an expired code is refused', async () => {
    const { service, challenges, challengeId } = await pending();
    const { code } = await service.approve('u1', 'phone', challengeId);
    challenges[0].codeExpiresAt = new Date(Date.now() - 1);
    await expect(
      service.consumeWithCode(challengeId, 'stranger', code),
    ).rejects.toThrow(/已失效/);
  });

  it('a rejected challenge cannot be approved or used', async () => {
    const { service, challenges, challengeId } = await pending();
    await service.reject('u1', 'phone', challengeId);
    expect(challenges[0].status).toBe('REJECTED');
    await expect(service.approve('u1', 'phone', challengeId)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.status(challengeId, 'stranger')).resolves.toEqual(
      expect.objectContaining({ status: 'REJECTED' }),
    );
    await expect(service.resend(challengeId, 'stranger')).rejects.toThrow(
      /拒绝/,
    );
  });

  it('resend opens a fresh challenge only after the old one expired', async () => {
    const { service, challenges, challengeId } = await pending();
    const same = await service.resend(challengeId, 'stranger');
    expect(same.id).toBe(challengeId);
    challenges[0].expiresAt = new Date(Date.now() - 1);
    const fresh = await service.resend(challengeId, 'stranger');
    expect(fresh.id).not.toBe(challengeId);
    expect(challenges).toHaveLength(2);
  });

  it('the security-code fallback shares the per-challenge attempt cap', async () => {
    const { service, challenges, challengeId } = await pending();
    for (let i = 0; i < LOGIN_CHALLENGE_MAX_ATTEMPTS - 1; i += 1) {
      await service.registerSecurityCodeFailure(challengeId);
    }
    // 第 5 次输错即回「已作废」，之后再错也不会越过上限。
    await expect(
      service.registerSecurityCodeFailure(challengeId),
    ).rejects.toThrow(/错误次数过多/);
    await expect(
      service.registerSecurityCodeFailure(challengeId),
    ).rejects.toThrow(/错误次数过多/);
    expect(challenges[0].attempts).toBe(LOGIN_CHALLENGE_MAX_ATTEMPTS);
    await expect(
      service.loadForSecurityCode(challengeId, 'stranger'),
    ).rejects.toThrow(/错误次数过多/);
  });

  it('listPending only asks about requests nobody has handled yet', async () => {
    const { service, challengeId } = await pending();
    await service.approve('u1', 'phone', challengeId);
    await expect(service.listPending('u1', 'phone')).resolves.toEqual([]);
  });

  it('an approved request whose code expired can be reopened instead of waiting out the window', async () => {
    const { service, challenges, challengeId, realtime } = await pending();
    await service.approve('u1', 'phone', challengeId);
    challenges[0].codeExpiresAt = new Date(Date.now() - 1);
    realtime.broadcast.mockClear();

    const again = await service.resend(challengeId, 'stranger');

    expect(again.id).toBe(challengeId);
    expect(challenges[0]).toEqual(
      expect.objectContaining({ status: 'PENDING', codeHash: null }),
    );
    // 受信任设备重新收到「是否是你本人」。
    expect(realtime.broadcast).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({ type: 'auth.login.challenge.created' }),
    );
    await expect(service.listPending('u1', 'phone')).resolves.toHaveLength(1);
  });

  it('logging in again on the same device also reopens an expired code', async () => {
    const { service, challenges, challengeId } = await pending();
    await service.approve('u1', 'phone', challengeId);
    challenges[0].codeExpiresAt = new Date(Date.now() - 1);

    const decision = await service.evaluateLogin(user, {
      deviceKey: 'stranger',
    });

    expect(decision).toEqual(
      expect.objectContaining({
        kind: 'challenge',
        challenge: expect.objectContaining({ id: challengeId }),
      }),
    );
    expect(challenges[0].status).toBe('PENDING');
  });

  it('invalidating challenges (password change, logout-all) kills open ones and blocks resend', async () => {
    const { service, challenges, challengeId, realtime } = await pending();
    await service.invalidateChallenges('u1');

    expect(challenges[0].status).toBe('REJECTED');
    expect(realtime.broadcast).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        type: 'auth.login.challenge.resolved',
        payload: expect.objectContaining({ challengeId, status: 'REJECTED' }),
      }),
    );
    await expect(service.resend(challengeId, 'stranger')).rejects.toThrow(
      /拒绝/,
    );
  });

  it('the security-code fallback has an account-wide daily failure budget', async () => {
    const { service, challenges } = await pending();
    await expect(
      service.assertSecurityCodeFallbackBudget('u1'),
    ).resolves.toBeUndefined();
    challenges[0].attempts = LOGIN_CHALLENGE_SECURITY_CODE_DAILY_FAILURES;
    await expect(
      service.assertSecurityCodeFallbackBudget('u1'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('listPending is empty for an untrusted caller', async () => {
    const { service } = await pending();
    await expect(service.listPending('u1', 'stranger')).resolves.toEqual([]);
    await expect(service.listPending('u1', 'phone')).resolves.toHaveLength(1);
  });
});

describe('DeviceTrustService revocation', () => {
  it('revokeOtherDevices keeps only the current device trusted', async () => {
    const { service, trusted, trust } = setup();
    trust('phone');
    trust('tablet');
    trust('laptop');
    await service.revokeOtherDevices('u1', 'phone');
    expect(trusted.filter((t) => !t.revokedAt).map((t) => t.deviceKey)).toEqual(
      ['phone'],
    );
  });

  it('trustOnRefresh records a never-seen device (rollout back-fill)', async () => {
    const { service, trusted } = setup();
    await service.trustOnRefresh('u1', 'legacy-phone', {
      deviceName: 'iPhone',
    });
    expect(trusted).toEqual([
      expect.objectContaining({ deviceKey: 'legacy-phone', revokedAt: null }),
    ]);
  });

  it('trustOnRefresh never revives a device removed in device management', async () => {
    const { service, trusted, trust } = setup();
    trust('removed');
    const revokedAt = new Date();
    trusted[0].revokedAt = revokedAt;
    await service.trustOnRefresh('u1', 'removed', {});
    expect(trusted[0].revokedAt).toBe(revokedAt);
  });

  it('trust() re-trusts a revoked device after it passes verification', async () => {
    const { service, trusted, trust } = setup();
    trust('phone');
    trusted[0].revokedAt = new Date();
    await service.trust('u1', 'phone', {});
    expect(trusted[0].revokedAt).toBeNull();
  });
});

describe('account-serialized login limits', () => {
  it('caps concurrent challenge creation across different devices at the account limit', async () => {
    const { service, trust, challenges } = setup();
    trust('phone');
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        service.evaluateLogin(user, {
          deviceKey: `new-${i}`,
          ip: `203.0.113.${i + 1}`,
        }),
      ),
    );
    expect(challenges).toHaveLength(LOGIN_CHALLENGE_ACCOUNT_RATE_LIMIT);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      LOGIN_CHALLENGE_ACCOUNT_RATE_LIMIT,
    );
  });

  it('counts failed security-code guesses atomically across challenges', async () => {
    const { service, trust, challenges } = setup();
    trust('phone');
    for (let i = 0; i < 3; i++)
      await service.evaluateLogin(user, {
        deviceKey: `new-${i}`,
        ip: `203.0.113.${i + 1}`,
      });
    const verify = jest.fn(async () => false);
    await Promise.allSettled(
      Array.from({ length: 25 }, (_, i) =>
        service.verifySecurityCodeFallback(
          challenges[i % 3].id,
          `new-${i % 3}`,
          verify,
        ),
      ),
    );
    expect(verify).toHaveBeenCalledTimes(
      LOGIN_CHALLENGE_SECURITY_CODE_DAILY_FAILURES,
    );
    expect(challenges.reduce((sum, c) => sum + c.attempts, 0)).toBe(
      LOGIN_CHALLENGE_SECURITY_CODE_DAILY_FAILURES,
    );
    expect(
      challenges.every((c) => c.attempts <= LOGIN_CHALLENGE_MAX_ATTEMPTS),
    ).toBe(true);
  });

  it('consumes a successful fallback only once under concurrent submissions', async () => {
    const { service, trust, challenges } = setup();
    trust('phone');
    await service.evaluateLogin(user, { deviceKey: 'new' });
    const verify = jest.fn(async () => true);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        service.verifySecurityCodeFallback(challenges[0].id, 'new', verify),
      ),
    );
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value),
    ).toHaveLength(1);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(challenges[0].status).toBe('CONSUMED');
  });
});

test('invalid approval challenges are rejected before invoking Argon2', async () => {
  const { service, trust } = setup();
  trust('phone');
  const hash = jest.mocked(argon2.hash);
  hash.mockClear();
  try {
    await expect(service.approve('u1', 'phone', 'missing')).rejects.toThrow();
    expect(hash).not.toHaveBeenCalled();
  } finally {
    hash.mockClear();
  }
});

test('concurrent wrong candidates reserve at most five Argon2 comparisons', async () => {
  const { service, trust, challenges } = setup();
  trust('phone');
  await service.evaluateLogin(user, { deviceKey: 'new' });
  await service.approve('u1', 'phone', challenges[0].id);
  const verify = jest
    .mocked(argon2.verify)
    .mockClear()
    .mockImplementation(async () => false);
  try {
    await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        service.consumeWithCode(
          challenges[0].id,
          'new',
          String(i).padStart(6, '0'),
        ),
      ),
    );
    expect(verify).toHaveBeenCalledTimes(5);
    expect(challenges[0].attempts).toBe(5);
  } finally {
    verify.mockImplementation(jest.requireActual('argon2').verify);
  }
});

test('resend rechecks a source challenge invalidated during account recovery', async () => {
  const { service, trust, prisma, challenges } = setup();
  trust('phone');
  await service.evaluateLogin(user, { deviceKey: 'new' });
  const old = { ...challenges[0], expiresAt: new Date(Date.now() - 1000) };
  prisma.loginChallenge.findUnique
    .mockResolvedValueOnce(old)
    .mockResolvedValueOnce({ ...old, status: 'REJECTED' });
  prisma.loginChallenge.create.mockClear();
  await expect(service.resend(old.id, 'new')).rejects.toThrow();
  expect(prisma.loginChallenge.create).not.toHaveBeenCalled();
});
