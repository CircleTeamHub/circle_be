import { Logger } from '@nestjs/common';
import type { PrismaService } from 'src/prisma/prisma.service';
import { sessionVerificationQuery } from '../session-verification.query';
import { SessionVerifier } from '../session-verifier.service';
import {
  sessionVerificationRow,
  type RowSession,
} from './session-verification-row.fixture';
import type {
  RevocationState,
  SessionRevocationService,
} from '../session-revocation.service';

function revocationReturning(state: RevocationState) {
  return {
    checkRevocation: jest.fn().mockResolvedValue(state),
  } as unknown as SessionRevocationService;
}

/**
 * 判定只走一条 $queryRaw(session-verification.query.ts)。旧的三个委托留着,
 * 只为断言它们不再被调用 —— 回退成多次往返的话这里会响。
 */
function createPrismaMock() {
  return {
    $queryRaw: jest.fn(),
    user: { findUnique: jest.fn() },
    refreshToken: { findUnique: jest.fn() },
    sessionScopeGeneration: { findMany: jest.fn() },
  };
}

const payload = {
  sub: 'user-1',
  accountId: 'alice',
  role: 'USER' as const,
  sid: 'session-1',
  aud: 'APP' as const,
};

const liveSession: RowSession = {
  id: 'session-1',
  userId: 'user-1',
  familyId: 'family-1',
  audience: 'APP',
  deviceKey: 'device-1',
  accountGeneration: 0,
  audienceGeneration: 0,
  deviceGeneration: 0,
  familyGeneration: 0,
  revokedAt: null,
  revocationReason: null,
  accessRevokedAt: null,
};

describe('SessionVerifier', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  const verifierWith = (state: RevocationState) =>
    new SessionVerifier(
      revocationReturning(state),
      prisma as unknown as PrismaService,
    );

  const databaseReturns = (
    ...args: Parameters<typeof sessionVerificationRow>
  ) => prisma.$queryRaw.mockResolvedValue([sessionVerificationRow(...args)]);

  const expectNoLegacyLookups = () => {
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    expect(prisma.sessionScopeGeneration.findMany).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    prisma = createPrismaMock();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when Redis answers', () => {
    it('returns a Redis revocation without touching the database', async () => {
      await expect(verifierWith('revoked').verify(payload)).resolves.toBe(
        'revoked',
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expectNoLegacyLookups();
    });

    it('does not let a missing Redis marker override a durable logout', async () => {
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: null },
        {
          ...liveSession,
          revokedAt: new Date('2026-09-14T00:00:00.000Z'),
          revocationReason: 'LOGOUT',
        },
      );

      await expect(verifierWith('active').verify(payload)).resolves.toBe(
        'revoked',
      );
    });
  });

  // Redis 在生产里是可选的（.env.production.example 发的是 REDIS_REQUIRED=false）。
  // 没配或故障时吊销标记查不到，以前一律放行 —— 封禁 / 登出 / 改密对未过期的
  // access token 形同虚设。现在回落数据库核对账号状态与会话行；HTTP 与两个
  // WebSocket 网关共用这一份判定，免得某一侧又悄悄 fail-open。
  describe('database fallback when Redis cannot answer', () => {
    let verifier: SessionVerifier;

    beforeEach(() => {
      verifier = verifierWith('unknown');
    });

    it('is active for an ACTIVE user with a live session, via indexed lookups', async () => {
      databaseReturns({ status: 'ACTIVE' }, liveSession);

      await expect(verifier.verify(payload)).resolves.toBe('active');
      // sid 就是 RefreshToken 的主键（refresh-token.service 的 revoke 注释）；
      // 三张表都按主键/唯一索引取，由 test/postgres/session-verification.pg-spec.ts 守着。
      expect(prisma.$queryRaw).toHaveBeenCalledWith(
        sessionVerificationQuery('user-1', 'session-1'),
      );
    });

    // 每个已登录请求都走这里：用户、会话、generation 合成一条语句，
    // 一次往返、一个池连接（原来两次往返、瞬间占两个连接）。
    it('makes exactly one database round trip per verification', async () => {
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: null },
        liveSession,
        [{ scope: 'ACCOUNT', generation: 0, exemptFamilyId: null }],
      );

      await expect(verifier.verifyWithIdentity(payload)).resolves.toMatchObject(
        { verdict: 'active' },
      );
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expectNoLegacyLookups();
    });

    it.each(['BANNED', 'DELETED'])(
      'is revoked for a %s user',
      async (status) => {
        databaseReturns({ status }, liveSession);

        await expect(verifier.verify(payload)).resolves.toBe('revoked');
      },
    );

    it('is revoked when the user no longer exists', async () => {
      databaseReturns(null, null);

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('is revoked for a logged-out session row', async () => {
      databaseReturns(
        { status: 'ACTIVE' },
        {
          ...liveSession,
          revokedAt: new Date('2026-09-01T00:00:00.000Z'),
          revocationReason: 'LOGOUT',
        },
      );

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('stays active for a rotated session row, matching the Redis path', async () => {
      // 刷新轮换把旧行标成 ROTATED、签发带新 sid 的 token；Redis 路径不为轮换写吊销
      // 标记。回落路径若把 ROTATED 当吊销，轮换瞬间在途的请求会被无端拒掉。
      databaseReturns(
        { status: 'ACTIVE' },
        {
          ...liveSession,
          revokedAt: new Date('2026-09-01T00:00:00.000Z'),
          revocationReason: 'ROTATED',
        },
      );

      await expect(verifier.verify(payload)).resolves.toBe('active');
    });

    it('rejects a rotated session after durable per-session access revocation', async () => {
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: null },
        {
          ...liveSession,
          revokedAt: new Date('2026-09-01T00:00:00.000Z'),
          revocationReason: 'ROTATED',
          accessRevokedAt: new Date('2026-09-02T00:00:00.000Z'),
        },
      );

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('rejects an access token whose device generation is stale', async () => {
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: null },
        liveSession,
        [{ scope: 'DEVICE', generation: 1, exemptFamilyId: null }],
      );

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('keeps the preserved family active across an account generation bump', async () => {
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: null },
        liveSession,
        [{ scope: 'ACCOUNT', generation: 1, exemptFamilyId: 'family-1' }],
      );

      await expect(verifier.verify(payload)).resolves.toBe('active');
    });

    it('returns the durable scope identity used by realtime revocation', async () => {
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: null },
        liveSession,
      );

      await expect(verifier.verifyWithIdentity(payload)).resolves.toEqual({
        verdict: 'active',
        identity: {
          sessionId: 'session-1',
          familyId: 'family-1',
          audience: 'APP',
          deviceKey: 'device-1',
          issuedAtMs: null,
        },
      });
    });

    it('rejects a rotated session after a durable user-wide revocation', async () => {
      const revokedAt = new Date('2026-09-01T00:00:00.000Z');
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: revokedAt },
        {
          ...liveSession,
          revokedAt: new Date('2026-08-31T23:59:00.000Z'),
          revocationReason: 'ROTATED',
        },
      );

      await expect(
        verifier.verify({ ...payload, iat: revokedAt.getTime() / 1000 - 1 }),
      ).resolves.toBe('revoked');
    });

    it('stays active when the session row was already cleaned up and the user is ACTIVE', async () => {
      // RefreshTokenCleanup 会删掉已过期的行，而 refresh TTL 可以配得比 access TTL 短：
      // 行不在不代表 access token 已死，此时只按账号状态判。
      databaseReturns({ status: 'ACTIVE' }, null);

      await expect(verifier.verify(payload)).resolves.toBe('active');
    });

    it('is revoked when the session row belongs to another user', async () => {
      databaseReturns(
        { status: 'ACTIVE' },
        {
          ...liveSession,
          userId: 'user-2',
        },
      );

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('checks only the account when the token carries no session id', async () => {
      databaseReturns({ status: 'ACTIVE' }, null);
      const withoutSession = {
        sub: payload.sub,
        accountId: payload.accountId,
        role: payload.role,
        aud: payload.aud,
      };

      await expect(verifier.verify(withoutSession)).resolves.toBe('active');
      // sessionId 传 NULL：RefreshToken 的 JOIN 不可能命中，generation 也不取。
      expect(prisma.$queryRaw).toHaveBeenCalledWith(
        sessionVerificationQuery('user-1', null),
      );
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it('is revoked, without querying, when the token has no string subject', async () => {
      await expect(verifier.verify({ sid: 'session-1' })).resolves.toBe(
        'revoked',
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expectNoLegacyLookups();
    });

    // Redis 与数据库都答不上来：这不是「会话已吊销」，而是「暂时核验不了」。
    // 调用方据此回 503 / 可重试的关闭码，客户端保留登录态；若当成吊销，一次
    // Redis+数据库同时抖动就会把所有在线用户登出。
    it('is unavailable, not revoked, when the database lookup fails', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('db down'));

      await expect(verifier.verify(payload)).resolves.toBe('unavailable');
    });

    // —— 以下是合并成一条查询后新增的边界：判定顺序与旧的两段查询逐条对齐 ——

    it('never looks a session up for an empty session id, as before', async () => {
      // 旧代码用真值判断决定是否查会话行，空串 sid 等同没有 sid。
      databaseReturns({ status: 'ACTIVE' }, null);

      await expect(
        verifier.verifyWithIdentity({ ...payload, sid: '' }),
      ).resolves.toEqual({ verdict: 'active', identity: null });
      expect(prisma.$queryRaw).toHaveBeenCalledWith(
        sessionVerificationQuery('user-1', null),
      );
    });

    it('is revoked when an account-wide revocation exists and the token has no issue time', async () => {
      databaseReturns(
        {
          status: 'ACTIVE',
          accessTokensRevokedAt: new Date('2026-09-01T00:00:00.000Z'),
        },
        liveSession,
      );

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('stays active for a token issued after the account-wide revocation', async () => {
      const revokedAt = new Date('2026-09-01T00:00:00.000Z');
      databaseReturns(
        { status: 'ACTIVE', accessTokensRevokedAt: revokedAt },
        liveSession,
      );

      await expect(
        verifier.verify({ ...payload, issuedAtMs: revokedAt.getTime() + 1 }),
      ).resolves.toBe('active');
      await expect(
        verifier.verify({ ...payload, issuedAtMs: revokedAt.getTime() }),
      ).resolves.toBe('revoked');
    });

    it('does not consult generations before the account and session checks pass', async () => {
      // generation 原来在会话检查通过后才查；现在一并取回，但前面已判 revoked 时
      // 这一列再异常也不能把结论改成 unavailable。
      prisma.$queryRaw.mockResolvedValue([
        {
          ...sessionVerificationRow({ status: 'BANNED' }, liveSession),
          generations: 'not-an-array',
        },
      ]);

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('is unavailable when the generation list is malformed after the checks pass', async () => {
      // 对应旧实现第二条查询失败的那个出口。
      prisma.$queryRaw.mockResolvedValue([
        {
          ...sessionVerificationRow({ status: 'ACTIVE' }, liveSession),
          generations: [{ scope: 'NOT_A_SCOPE', generation: 1 }],
        },
      ]);

      await expect(verifier.verify(payload)).resolves.toBe('unavailable');
    });

    it('is unavailable when the lookup does not return exactly one well-formed row', async () => {
      prisma.$queryRaw.mockResolvedValueOnce([]);
      await expect(verifier.verify(payload)).resolves.toBe('unavailable');

      prisma.$queryRaw.mockResolvedValueOnce([
        {
          ...sessionVerificationRow({ status: 'ACTIVE' }, liveSession),
          revokedAt: 'x',
        },
      ]);
      await expect(verifier.verify(payload)).resolves.toBe('unavailable');
    });
  });
});
