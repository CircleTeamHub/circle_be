import { Logger } from '@nestjs/common';
import type { PrismaService } from 'src/prisma/prisma.service';
import { SessionVerifier } from '../session-verifier.service';
import type {
  RevocationState,
  SessionRevocationService,
} from '../session-revocation.service';

function revocationReturning(state: RevocationState) {
  return {
    checkRevocation: jest.fn().mockResolvedValue(state),
  } as unknown as SessionRevocationService;
}

function createPrismaMock() {
  return {
    user: { findUnique: jest.fn() },
    refreshToken: { findUnique: jest.fn() },
  };
}

const payload = {
  sub: 'user-1',
  accountId: 'alice',
  role: 'USER' as const,
  sid: 'session-1',
  aud: 'APP' as const,
};

const liveSession = {
  userId: 'user-1',
  revokedAt: null,
  revocationReason: null,
};

describe('SessionVerifier', () => {
  let prisma: ReturnType<typeof createPrismaMock>;

  const verifierWith = (state: RevocationState) =>
    new SessionVerifier(
      revocationReturning(state),
      prisma as unknown as PrismaService,
    );

  beforeEach(() => {
    prisma = createPrismaMock();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when Redis answers', () => {
    it.each(['active', 'revoked'] as const)(
      'returns the Redis verdict (%s) without touching the database',
      async (state) => {
        await expect(verifierWith(state).verify(payload)).resolves.toBe(state);
        // 热路径：Redis 有结论就不多一次数据库查询。
        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
      },
    );
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
      prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      prisma.refreshToken.findUnique.mockResolvedValue(liveSession);

      await expect(verifier.verify(payload)).resolves.toBe('active');
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { status: true },
      });
      // sid 就是 RefreshToken 的主键（refresh-token.service 的 revoke 注释）。
      expect(prisma.refreshToken.findUnique).toHaveBeenCalledWith({
        where: { id: 'session-1' },
        select: { userId: true, revokedAt: true, revocationReason: true },
      });
    });

    it.each(['BANNED', 'DELETED'])(
      'is revoked for a %s user',
      async (status) => {
        prisma.user.findUnique.mockResolvedValue({ status });
        prisma.refreshToken.findUnique.mockResolvedValue(liveSession);

        await expect(verifier.verify(payload)).resolves.toBe('revoked');
      },
    );

    it('is revoked when the user no longer exists', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('is revoked for a logged-out session row', async () => {
      prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      prisma.refreshToken.findUnique.mockResolvedValue({
        userId: 'user-1',
        revokedAt: new Date('2026-09-01T00:00:00.000Z'),
        revocationReason: 'LOGOUT',
      });

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('stays active for a rotated session row, matching the Redis path', async () => {
      // 刷新轮换把旧行标成 ROTATED、签发带新 sid 的 token；Redis 路径不为轮换写吊销
      // 标记。回落路径若把 ROTATED 当吊销，轮换瞬间在途的请求会被无端拒掉。
      prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      prisma.refreshToken.findUnique.mockResolvedValue({
        userId: 'user-1',
        revokedAt: new Date('2026-09-01T00:00:00.000Z'),
        revocationReason: 'ROTATED',
      });

      await expect(verifier.verify(payload)).resolves.toBe('active');
    });

    it('stays active when the session row was already cleaned up and the user is ACTIVE', async () => {
      // RefreshTokenCleanup 会删掉已过期的行，而 refresh TTL 可以配得比 access TTL 短：
      // 行不在不代表 access token 已死，此时只按账号状态判。
      prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      prisma.refreshToken.findUnique.mockResolvedValue(null);

      await expect(verifier.verify(payload)).resolves.toBe('active');
    });

    it('is revoked when the session row belongs to another user', async () => {
      prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      prisma.refreshToken.findUnique.mockResolvedValue({
        ...liveSession,
        userId: 'user-2',
      });

      await expect(verifier.verify(payload)).resolves.toBe('revoked');
    });

    it('checks only the account when the token carries no session id', async () => {
      prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
      const withoutSession = {
        sub: payload.sub,
        accountId: payload.accountId,
        role: payload.role,
        aud: payload.aud,
      };

      await expect(verifier.verify(withoutSession)).resolves.toBe('active');
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    it('is revoked, without querying, when the token has no string subject', async () => {
      await expect(verifier.verify({ sid: 'session-1' })).resolves.toBe(
        'revoked',
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
    });

    // Redis 与数据库都答不上来：这不是「会话已吊销」，而是「暂时核验不了」。
    // 调用方据此回 503 / 可重试的关闭码，客户端保留登录态；若当成吊销，一次
    // Redis+数据库同时抖动就会把所有在线用户登出。
    it('is unavailable, not revoked, when the database lookup fails', async () => {
      prisma.user.findUnique.mockRejectedValue(new Error('db down'));
      prisma.refreshToken.findUnique.mockResolvedValue(liveSession);

      await expect(verifier.verify(payload)).resolves.toBe('unavailable');
    });
  });
});
