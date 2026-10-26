import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ForbiddenException,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Client } from 'pg';
import { AuthService } from 'src/auth/auth.service';
import { DeviceTrustService } from 'src/auth/device-trust.service';
import { RefreshTokenService } from 'src/auth/refresh-token.service';
import { AuthErrorCode } from 'src/common/app-error-codes';
import type { PrismaClient } from 'src/generated/prisma';
import { describePostgres } from './pg-test-db';
import {
  openPrismaSchema,
  type PrismaHandle,
  type PrismaSchemaDb,
} from './prisma-schema-db';

/**
 * APP 续签(AuthService.refresh)的真库回归。
 *
 * 以前:外层事务只拿 advisory 锁,嵌套的 rotate / 查用户 / 记 access 过期 /
 * assertSessionActive / 设备信任 / 取消找回全走 this.prisma —— 每次续签同时占两个
 * 连接(外层那个一直 idle in transaction),实测 23 次往返。
 * 现在:全部在外层事务里做,一个连接,16 次往返;去掉锁前重复读的 token、紧跟
 * 创建的 assertSessionActive、第二次读 TrustedDevice;尽力而为的三步各用一个保存点。
 *
 * 「结论不变」那组用例先在旧实现上跑绿过一遍(基线),再在新实现上跑:正常续签、
 * 已吊销/过期/未知/错 audience、重放整族吊销、封禁、ADMIN、设备信任建立/不复活、
 * 尽力而为的步骤失败不挡续签、同 token 并发续签。
 */
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const SECRET = 'auth-refresh-pg-spec-secret';
const OTHER_DEVICE = 'b'.repeat(64);
const PHONE = 'a'.repeat(64);

type Harness = {
  auth: AuthService;
  revocation: {
    revokeSession: jest.Mock;
    revokeUser: jest.Mock;
    revokeScope: jest.Mock;
  };
  realtime: { broadcast: jest.Mock };
  jwt: JwtService;
};

function harness(prisma: PrismaClient): Harness {
  const config = new ConfigService({ JWT_EXPIRES_IN: '1h' });
  const revocation = {
    revokeSession: jest.fn(async () => true),
    revokeUser: jest.fn(async () => undefined),
    revokeScope: jest.fn(async () => true),
  };
  const realtime = { broadcast: jest.fn() };
  const jwt = new JwtService({
    secret: SECRET,
    signOptions: { expiresIn: 3600 },
  });
  const refreshTokens = new RefreshTokenService(
    prisma as never,
    config,
    revocation as never,
  );
  const deviceTrust = new DeviceTrustService(
    prisma as never,
    realtime as never,
  );
  const auth = new AuthService(
    prisma as never,
    refreshTokens,
    jwt,
    {} as never,
    {} as never,
    config,
    {} as never,
    {} as never,
    deviceTrust,
  );
  return { auth, revocation, realtime, jwt };
}

describePostgres('AuthService.refresh on a real database', () => {
  let env: PrismaSchemaDb;
  let db: Client;
  let main: PrismaHandle;
  let h: Harness;

  beforeAll(async () => {
    env = await openPrismaSchema('auth_refresh');
    db = env.db;
    main = env.client(6);
    h = harness(main.prisma);
  }, 60_000);

  afterAll(async () => {
    await env?.close();
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    await db.query(
      'TRUNCATE "LoginChallenge", "TrustedDevice", "SessionScopeGeneration", "RefreshToken", "User", "AccountIdentifier" CASCADE',
    );
  });

  const seedUser = async (
    overrides: { role?: string; status?: string; id?: string } = {},
  ) => {
    const id = overrides.id ?? randomUUID();
    await db.query(
      `INSERT INTO "AccountIdentifier" (value, "updatedAt") VALUES ($1, now())`,
      [`acc_${id.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO "User" (id, "accountId", "inviteCode", "passwordHash", nickname, "updatedAt", role, status, "lastOnline")
       VALUES ($1, $2, $3, 'x', 'n', now(), $4, $5, now())`,
      [
        id,
        `acc_${id.slice(0, 8)}`,
        `INV${id.slice(0, 8)}`,
        overrides.role ?? 'USER',
        overrides.status ?? 'ACTIVE',
      ],
    );
    return id;
  };

  type SessionSeed = {
    userId: string;
    familyId?: string;
    deviceKey?: string | null;
    deviceName?: string | null;
    audience?: 'APP' | 'ADMIN';
    revokedAt?: Date | null;
    reason?: string | null;
    expiredAt?: Date;
  };
  const seedSession = async (seed: SessionSeed) => {
    const raw = randomBytes(64).toString('hex');
    const id = randomUUID();
    await db.query(
      `INSERT INTO "RefreshToken" (id, "userId", token, "familyId", audience, "deviceKey", "deviceName", "revokedAt", "revocationReason", "expiredAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        id,
        seed.userId,
        sha256(raw),
        seed.familyId ?? randomUUID(),
        seed.audience ?? 'APP',
        seed.deviceKey === undefined ? PHONE : seed.deviceKey,
        seed.deviceName === undefined ? 'Owner iPhone' : seed.deviceName,
        seed.revokedAt ?? null,
        seed.reason ?? null,
        seed.expiredAt ?? new Date(Date.now() + 86_400_000),
      ],
    );
    return { raw, id };
  };

  const seedTrusted = async (
    userId: string,
    deviceKey: string,
    revokedAt: Date | null = null,
  ) => {
    await db.query(
      `INSERT INTO "TrustedDevice" (id, "userId", "deviceKey", "deviceName", "lastIp", "lastSeenAt", "revokedAt")
       VALUES ($1, $2, $3, 'old name', '10.0.0.1', '2026-01-01T00:00:00Z', $4)`,
      [randomUUID(), userId, deviceKey, revokedAt],
    );
  };

  const seedChallenge = async (
    userId: string,
    deviceKey: string,
    recovery: boolean,
  ) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "LoginChallenge" (id, "userId", "deviceKey", status, "expiresAt", "recoveryRequestedAt", "recoveryAvailableAt")
       VALUES ($1, $2, $3, 'PENDING', now() + interval '1 day', $4, $5)`,
      [
        id,
        userId,
        deviceKey,
        recovery ? new Date() : null,
        recovery ? new Date(Date.now() + 86_400_000) : null,
      ],
    );
    return id;
  };

  const session = async (raw: string) =>
    (
      await db.query<{
        id: string;
        userId: string;
        familyId: string;
        deviceKey: string | null;
        deviceName: string | null;
        ip: string | null;
        revokedAt: Date | null;
        revocationReason: string | null;
        accessTokenExpiresAt: Date | null;
      }>(
        `SELECT id, "userId", "familyId", "deviceKey", "deviceName", ip, "revokedAt",
                "revocationReason"::text AS "revocationReason", "accessTokenExpiresAt"
         FROM "RefreshToken" WHERE token = $1`,
        [sha256(raw)],
      )
    ).rows[0];

  const sessionsOf = async (userId: string) =>
    (
      await db.query<{
        id: string;
        revokedAt: Date | null;
        revocationReason: string | null;
      }>(
        `SELECT id, "revokedAt", "revocationReason"::text AS "revocationReason"
         FROM "RefreshToken" WHERE "userId" = $1 ORDER BY "createdAt", id`,
        [userId],
      )
    ).rows;

  const snapshot = async () =>
    JSON.stringify(
      (
        await db.query(
          `SELECT (SELECT json_agg(r ORDER BY r.id) FROM "RefreshToken" r) AS tokens,
                  (SELECT json_agg(u ORDER BY u.id) FROM "User" u) AS users,
                  (SELECT json_agg(t ORDER BY t.id) FROM "TrustedDevice" t) AS trusted,
                  (SELECT json_agg(c ORDER BY c.id) FROM "LoginChallenge" c) AS challenges`,
        )
      ).rows[0],
    );

  const challengeStatus = async (id: string) =>
    (
      await db.query<{ status: string }>(
        `SELECT status::text AS status FROM "LoginChallenge" WHERE id = $1`,
        [id],
      )
    ).rows[0].status;

  const trustedRow = async (userId: string, deviceKey: string) =>
    (
      await db.query<{
        deviceName: string | null;
        lastIp: string | null;
        lastSeenAt: Date;
        revokedAt: Date | null;
      }>(
        `SELECT "deviceName", "lastIp", "lastSeenAt", "revokedAt" FROM "TrustedDevice"
         WHERE "userId" = $1 AND "deviceKey" = $2`,
        [userId, deviceKey],
      )
    ).rows[0];

  const rejection = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(HttpException);
    return error as HttpException;
  };

  describe('outcomes (identical before and after the single-transaction rewrite)', () => {
    it('rotates, issues a bound access token, touches the trusted device and cancels foreign recoveries', async () => {
      const userId = await seedUser();
      const familyId = randomUUID();
      const old = await seedSession({ userId, familyId });
      await seedTrusted(userId, PHONE);
      const recovery = await seedChallenge(userId, OTHER_DEVICE, true);
      const ordinary = await seedChallenge(userId, OTHER_DEVICE, false);

      const before = Date.now();
      const result = await h.auth.refresh(old.raw, {
        ip: '203.0.113.9',
        userAgent: 'ua',
      });

      const retired = await session(old.raw);
      expect(retired.revokedAt).not.toBeNull();
      expect(retired.revocationReason).toBe('ROTATED');
      const next = await session(result.refreshToken);
      expect(next).toMatchObject({
        userId,
        familyId,
        deviceKey: PHONE,
        deviceName: 'Owner iPhone',
        ip: '203.0.113.9',
        revokedAt: null,
      });
      expect(next.accessTokenExpiresAt!.getTime()).toBeGreaterThanOrEqual(
        before + 3_600_000 - 1_000,
      );
      const payload = h.jwt.verify<Record<string, unknown>>(result.accessToken);
      expect(payload).toMatchObject({
        sub: userId,
        sid: next.id,
        aud: 'APP',
        role: 'USER',
        accountId: `acc_${userId.slice(0, 8)}`,
      });

      const device = await trustedRow(userId, PHONE);
      expect(device.revokedAt).toBeNull();
      expect(device.lastIp).toBe('203.0.113.9');
      expect(device.deviceName).toBe('Owner iPhone');
      expect(device.lastSeenAt.getTime()).toBeGreaterThanOrEqual(
        before - 1_000,
      );
      expect(await challengeStatus(recovery)).toBe('REJECTED');
      expect(await challengeStatus(ordinary)).toBe('PENDING');
      expect(h.realtime.broadcast).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          type: 'auth.login.challenge.resolved',
          payload: expect.objectContaining({
            challengeId: recovery,
            status: 'REJECTED',
          }),
        }),
      );
      expect(h.revocation.revokeUser).not.toHaveBeenCalled();
      expect(h.revocation.revokeSession).not.toHaveBeenCalled();
    });

    it.each([
      [
        'revoked by logout',
        { revokedAt: new Date(), reason: 'LOGOUT' } as Partial<SessionSeed>,
      ],
      ['expired', { expiredAt: new Date(Date.now() - 1_000) }],
      ['issued for the admin console', { audience: 'ADMIN' as const }],
    ])(
      'rejects a token that is %s without changing anything',
      async (_, seed) => {
        const userId = await seedUser();
        const old = await seedSession({ userId, ...seed });
        const before = await snapshot();
        const error = await rejection(h.auth.refresh(old.raw));
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.message).toBe('Invalid or expired refresh token');
        expect(await snapshot()).toBe(before);
      },
    );

    it('rejects an unknown token', async () => {
      const error = await rejection(h.auth.refresh('f'.repeat(128)));
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error.message).toBe('Invalid or expired refresh token');
    });

    it('treats a replayed rotated token as theft: the whole family is revoked and stays revoked', async () => {
      const userId = await seedUser();
      const familyId = randomUUID();
      const replayed = await seedSession({
        userId,
        familyId,
        revokedAt: new Date(Date.now() - 60_000),
        reason: 'ROTATED',
      });
      const successor = await seedSession({ userId, familyId });
      const otherFamily = await seedSession({ userId });

      const error = await rejection(h.auth.refresh(replayed.raw));
      expect(error).toBeInstanceOf(UnauthorizedException);
      expect(error.message).toBe(
        'Refresh token reuse detected; token family revoked',
      );

      expect(await session(successor.raw)).toMatchObject({
        revocationReason: 'TOKEN_FAMILY_REUSE',
      });
      expect((await session(successor.raw)).revokedAt).not.toBeNull();
      expect(await session(replayed.raw)).toMatchObject({
        revocationReason: 'ROTATED',
      });
      expect(await session(otherFamily.raw)).toMatchObject({
        revokedAt: null,
      });
      const user = await db.query<{ accessTokensRevokedAt: Date | null }>(
        `SELECT "accessTokensRevokedAt" FROM "User" WHERE id = $1`,
        [userId],
      );
      expect(user.rows[0].accessTokensRevokedAt).not.toBeNull();
      const byId = (a: string, b: string) => a.localeCompare(b);
      expect(
        h.revocation.revokeSession.mock.calls
          .map(([id]) => String(id))
          .sort(byId),
      ).toEqual([replayed.id, successor.id].sort(byId));
    });

    it.each([
      [
        'a banned user',
        { status: 'BANNED' },
        AuthErrorCode.AccountDisabled,
        '账号已被禁用',
      ],
      [
        'an ADMIN account on the APP audience',
        { role: 'ADMIN' },
        AuthErrorCode.InvalidCredentials,
        '邮箱、用户ID或密码错误',
      ],
    ])(
      'blocks %s and revokes every session, including the one just rotated',
      async (_, user, errorCode, message) => {
        const userId = await seedUser(user);
        const old = await seedSession({ userId });
        const other = await seedSession({ userId, deviceKey: OTHER_DEVICE });

        const error = await rejection(h.auth.refresh(old.raw));
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error.getResponse()).toMatchObject({ message, errorCode });

        const rows = await sessionsOf(userId);
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
        expect(await session(old.raw)).toMatchObject({
          revocationReason: 'ROTATED',
        });
        expect(await session(other.raw)).toMatchObject({
          revocationReason: 'LOGOUT_ALL',
        });
        // 刚轮换出的那条也被 LOGOUT_ALL 撤掉(它从没交给客户端)。
        expect(
          rows.filter((row) => row.revocationReason === 'LOGOUT_ALL'),
        ).toHaveLength(2);
        const after = await db.query<{ accessTokensRevokedAt: Date | null }>(
          `SELECT "accessTokensRevokedAt" FROM "User" WHERE id = $1`,
          [userId],
        );
        expect(after.rows[0].accessTokensRevokedAt).not.toBeNull();
        expect(h.revocation.revokeUser).toHaveBeenCalledWith(userId);
      },
    );

    it('back-fills trust for a never-seen bound device and then cancels foreign recoveries', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId });
      const recovery = await seedChallenge(userId, OTHER_DEVICE, true);

      await h.auth.refresh(old.raw, { ip: '198.51.100.7' });

      expect(await trustedRow(userId, PHONE)).toMatchObject({
        deviceName: 'Owner iPhone',
        lastIp: '198.51.100.7',
        revokedAt: null,
      });
      expect(await challengeStatus(recovery)).toBe('REJECTED');
    });

    it('never revives trust removed in device management, and then leaves recoveries alone', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId });
      const removedAt = new Date('2026-02-02T00:00:00Z');
      await seedTrusted(userId, PHONE, removedAt);
      const recovery = await seedChallenge(userId, OTHER_DEVICE, true);

      const result = await h.auth.refresh(old.raw, { ip: '198.51.100.7' });

      expect(result.refreshToken).toHaveLength(128);
      const device = await trustedRow(userId, PHONE);
      expect(device.revokedAt).toEqual(removedAt);
      expect(device.lastIp).toBe('10.0.0.1');
      expect(device.lastSeenAt).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect(await challengeStatus(recovery)).toBe('PENDING');
    });

    it('does not record trust for a legacy session without a device', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId, deviceKey: null });
      const recovery = await seedChallenge(userId, OTHER_DEVICE, true);

      const result = await h.auth.refresh(old.raw);

      expect((await session(result.refreshToken)).deviceKey).toBeNull();
      const trusted = await db.query('SELECT 1 FROM "TrustedDevice"');
      expect(trusted.rowCount).toBe(0);
      expect(await challengeStatus(recovery)).toBe('PENDING');
    });

    it('a failing trust back-fill never breaks the refresh, and the rotation still commits', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId });
      const recovery = await seedChallenge(userId, OTHER_DEVICE, true);
      await db.query(`
        CREATE FUNCTION refuse_trust() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'trust storage unavailable'; END $$;
        CREATE TRIGGER refuse_trust BEFORE INSERT ON "TrustedDevice"
          FOR EACH ROW EXECUTE FUNCTION refuse_trust();
      `);
      try {
        const result = await h.auth.refresh(old.raw);
        expect(await session(result.refreshToken)).toMatchObject({
          revokedAt: null,
          familyId: (await session(old.raw)).familyId,
        });
        expect((await session(old.raw)).revocationReason).toBe('ROTATED');
        // 信任没记上 → 不算受信任设备 → 找回不取消(与原来单独 isTrusted 的结论一致)。
        expect(await challengeStatus(recovery)).toBe('PENDING');
      } finally {
        await db.query(
          'DROP TRIGGER refuse_trust ON "TrustedDevice"; DROP FUNCTION refuse_trust()',
        );
      }
    });

    it('a failing recovery cancellation never breaks the refresh; trust and rotation still commit', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId });
      await seedTrusted(userId, PHONE);
      const recovery = await seedChallenge(userId, OTHER_DEVICE, true);
      await db.query(`
        CREATE FUNCTION refuse_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'challenge storage unavailable'; END $$;
        CREATE TRIGGER refuse_cancel BEFORE UPDATE ON "LoginChallenge"
          FOR EACH ROW EXECUTE FUNCTION refuse_cancel();
      `);
      try {
        const result = await h.auth.refresh(old.raw, { ip: '192.0.2.44' });
        expect((await session(result.refreshToken)).revokedAt).toBeNull();
        expect((await trustedRow(userId, PHONE)).lastIp).toBe('192.0.2.44');
        expect(await challengeStatus(recovery)).toBe('PENDING');
        expect(h.realtime.broadcast).not.toHaveBeenCalled();
      } finally {
        await db.query(
          'DROP TRIGGER refuse_cancel ON "LoginChallenge"; DROP FUNCTION refuse_cancel()',
        );
      }
    });

    it('a failing access-expiry write never breaks the refresh; the session commits with a null expiry', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId });
      await db.query(`
        CREATE FUNCTION refuse_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'expiry metadata unavailable'; END $$;
        CREATE TRIGGER refuse_expiry BEFORE UPDATE OF "accessTokenExpiresAt" ON "RefreshToken"
          FOR EACH ROW WHEN (NEW."accessTokenExpiresAt" IS NOT NULL)
          EXECUTE FUNCTION refuse_expiry();
      `);
      try {
        const result = await h.auth.refresh(old.raw);
        expect(await session(result.refreshToken)).toMatchObject({
          revokedAt: null,
          accessTokenExpiresAt: null,
        });
        expect((await session(old.raw)).revocationReason).toBe('ROTATED');
        // 后面的信任补记照常提交:失败的那一条没有把整个事务拖进 aborted。
        expect((await trustedRow(userId, PHONE)).revokedAt).toBeNull();
      } finally {
        await db.query(
          'DROP TRIGGER refuse_expiry ON "RefreshToken"; DROP FUNCTION refuse_expiry()',
        );
      }
    });

    it('serializes two refreshes of the same token: one rotates, the other is treated as replay', async () => {
      const userId = await seedUser();
      const familyId = randomUUID();
      const old = await seedSession({ userId, familyId });

      const results = await Promise.allSettled([
        h.auth.refresh(old.raw),
        h.auth.refresh(old.raw),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as Error).message).toBe(
        'Refresh token reuse detected; token family revoked',
      );
      const rows = await sessionsOf(userId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });
  });

  describe('connection and round-trip budget', () => {
    // touchLastOnline 是 PR A 的节流写,fire-and-forget、走自己的连接、不在本次范围;
    // 排除掉它,计数和连接峰值才是确定的。
    let touch: jest.SpyInstance;
    beforeEach(() => {
      touch = jest
        .spyOn(
          AuthService.prototype as unknown as {
            touchLastOnline: () => void;
          },
          'touchLastOnline',
        )
        .mockImplementation(() => undefined);
    });
    afterEach(() => touch.mockRestore());

    it('completes a refresh on a pool with a single connection', async () => {
      const single = env.client(1);
      const singleHarness = harness(single.prisma);
      const userId = await seedUser();
      const old = await seedSession({ userId });
      await seedTrusted(userId, PHONE);

      const result = await singleHarness.auth.refresh(old.raw);

      expect((await session(result.refreshToken)).revokedAt).toBeNull();
    });

    it('never checks out more than one connection at a time', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId });
      await seedTrusted(userId, PHONE);
      await seedChallenge(userId, OTHER_DEVICE, true);

      const observation = main.observe();
      await h.auth.refresh(old.raw);
      observation.stop();

      expect(observation.maxCheckedOut()).toBe(1);
    });

    it('a trusted, device-bound refresh takes 16 statements on one connection (was 23 on two)', async () => {
      const userId = await seedUser();
      const old = await seedSession({ userId });
      await seedTrusted(userId, PHONE);

      const observation = main.observe();
      await h.auth.refresh(old.raw);
      observation.stop();

      const schemaPrefix = `"${env.schema}".`;
      const label = (sql: string) => {
        const text = sql.split(schemaPrefix).join('');
        if (/pg_advisory_xact_lock/.test(text)) return 'advisory lock';
        if (/^(BEGIN|COMMIT|SAVEPOINT)/.test(text)) return text;
        const verb = text.split(' ')[0];
        const table =
          /(?:FROM|^UPDATE|^INSERT INTO) "(\w+)"/.exec(text)?.[1] ?? '?';
        return `${verb} ${table}`;
      };
      // 旧实现(同样的数据)实测 23 条、两个连接:rotate 自己的 BEGIN/COMMIT、锁前第二次
      // 读 token、assertSessionActive、TrustedDevice 读两次,外加 updateMany 在事务外
      // 被 Prisma 各包一层 BEGIN/COMMIT。
      expect(observation.statements.map(label)).toEqual([
        'SELECT RefreshToken', // ownerForToken:锁前定位要锁哪个账号
        'BEGIN',
        'advisory lock', // auth_session(账号锁)
        'advisory lock', // auth-user(轮换锁)
        'SELECT RefreshToken', // 锁后权威复核
        'UPDATE RefreshToken', // 旧 token → ROTATED
        'SELECT SessionScopeGeneration',
        'INSERT RefreshToken',
        'SELECT User',
        'SAVEPOINT refresh_access_expiry',
        'UPDATE RefreshToken', // accessTokenExpiresAt
        'SAVEPOINT refresh_device_trust',
        'UPDATE TrustedDevice', // 命中即受信任,不再 SELECT + isTrusted
        'SAVEPOINT refresh_recovery_cancel',
        'UPDATE LoginChallenge',
        'COMMIT',
      ]);
      const userRead = observation.statements.find(
        (sql) => label(sql) === 'SELECT User',
      );
      // 只取续签用得到的四列,不再整行(含 passwordHash 等)读回。
      expect(userRead).not.toContain('passwordHash');
      expect(observation.maxCheckedOut()).toBe(1);
    });
  });
});
