import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, Logger } from '@nestjs/common';
import { JwtStrategy } from '../auth.strategy';
import type {
  RevocationState,
  SessionRevocationService,
} from '../session-revocation.service';
import type { PrismaService } from 'src/prisma/prisma.service';
import { wasSecurityEventLogged } from 'src/logging/handled-errors';
import {
  getRequestContext,
  runWithRequestContext,
} from 'src/logging/request-context';

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

function asPrisma(prisma: ReturnType<typeof createPrismaMock>) {
  return prisma as unknown as PrismaService;
}

describe('JwtStrategy', () => {
  const config = {
    get: jest.fn(() => 'test-secret'),
  } as unknown as ConfigService;

  const payload = {
    sub: 'user-1',
    accountId: 'admin',
    role: 'ADMIN' as const,
    sid: 'session-1',
    aud: 'ADMIN' as const,
  };

  it('maps token audience onto the authenticated request user', async () => {
    const prisma = createPrismaMock();
    const strategy = new JwtStrategy(
      config,
      revocationReturning('active'),
      asPrisma(prisma),
    );

    await expect(strategy.validate(payload)).resolves.toEqual({
      userId: 'user-1',
      accountId: 'admin',
      role: 'ADMIN',
      sessionId: 'session-1',
      audience: 'ADMIN',
    });
    // Redis 给出了明确结论：热路径不多一次数据库查询。
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a revoked session (F-02) without touching the database', async () => {
    const prisma = createPrismaMock();
    const strategy = new JwtStrategy(
      config,
      revocationReturning('revoked'),
      asPrisma(prisma),
    );

    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe('JwtStrategy database fallback when the revocation state is unknown', () => {
  // Redis 在生产里是可选的（.env.production.example 发的是 REDIS_REQUIRED=false）。
  // 没配或故障时吊销标记查不到，以前一律放行 —— 封禁 / 登出 / 改密对未过期的
  // access token 形同虚设。现在回落数据库核对账号状态与会话行。
  const config = {
    get: jest.fn(() => 'test-secret'),
  } as unknown as ConfigService;
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

  let prisma: ReturnType<typeof createPrismaMock>;
  let strategy: JwtStrategy;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    prisma = createPrismaMock();
    strategy = new JwtStrategy(
      config,
      revocationReturning('unknown'),
      asPrisma(prisma),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets an ACTIVE user with a live session through after indexed lookups', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.refreshToken.findUnique.mockResolvedValue(liveSession);

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      userId: 'user-1',
      sessionId: 'session-1',
    });
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
    'rejects a %s user with 401',
    async (status) => {
      prisma.user.findUnique.mockResolvedValue({ status });
      prisma.refreshToken.findUnique.mockResolvedValue(liveSession);

      await expect(strategy.validate(payload)).rejects.toThrow(
        UnauthorizedException,
      );
    },
  );

  it('rejects a token whose user no longer exists', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.refreshToken.findUnique.mockResolvedValue(null);

    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a session that was logged out, as a revoked-session security event', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.refreshToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      revokedAt: new Date('2026-09-01T00:00:00.000Z'),
      revocationReason: 'LOGOUT',
    });

    const rejection = await strategy
      .validate(payload)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(UnauthorizedException);
    expect(wasSecurityEventLogged(rejection)).toBe(true);
  });

  it('keeps a rotated session row valid, matching the Redis path', async () => {
    // 刷新轮换把旧行标成 ROTATED、签发带新 sid 的 token；Redis 路径不为轮换写吊销
    // 标记。回落路径若把 ROTATED 当吊销，轮换瞬间在途的请求会被无端 401。
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.refreshToken.findUnique.mockResolvedValue({
      userId: 'user-1',
      revokedAt: new Date('2026-09-01T00:00:00.000Z'),
      revocationReason: 'ROTATED',
    });

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      userId: 'user-1',
    });
  });

  it('accepts a session row that was already cleaned up when the user is ACTIVE', async () => {
    // RefreshTokenCleanup 会删掉已过期的行，而 refresh TTL 可以配得比 access TTL 短：
    // 行不在不代表 access token 已死，此时只按账号状态判。
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.refreshToken.findUnique.mockResolvedValue(null);

    await expect(strategy.validate(payload)).resolves.toMatchObject({
      userId: 'user-1',
    });
  });

  it('rejects a session row that belongs to another user', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    prisma.refreshToken.findUnique.mockResolvedValue({
      ...liveSession,
      userId: 'user-2',
    });

    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('checks only the account when the token carries no session id', async () => {
    prisma.user.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    const { sid: _sid, ...withoutSession } = payload;

    await expect(strategy.validate(withoutSession)).resolves.toMatchObject({
      userId: 'user-1',
    });
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('rejects the request when the database lookup fails', async () => {
    prisma.user.findUnique.mockRejectedValue(new Error('db down'));
    prisma.refreshToken.findUnique.mockResolvedValue(liveSession);

    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});

describe('JwtStrategy request context & security events', () => {
  const originalEnv = process.env;
  const config = {
    get: jest.fn(() => 'test-secret'),
  } as unknown as ConfigService;
  const payload = {
    sub: 'user-1',
    accountId: 'alice',
    role: 'USER' as const,
    sid: 'session-1',
    aud: 'APP' as const,
  };

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('binds the token subject to the request context before the revocation check', async () => {
    const strategy = new JwtStrategy(
      config,
      revocationReturning('revoked'),
      asPrisma(createPrismaMock()),
    );

    await runWithRequestContext(
      { requestId: 'r-1', traceId: 'r-1', method: 'GET', path: '/api/v1/me' },
      async () => {
        await expect(strategy.validate(payload)).rejects.toThrow(
          UnauthorizedException,
        );
        expect(getRequestContext()?.userId).toBe('user-1');
      },
    );
  });

  it('logs a security event when a revoked session token is replayed', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      LOG_ON: 'true',
      SECURITY_LOG_ON: 'true',
    };
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const strategy = new JwtStrategy(
      config,
      revocationReturning('revoked'),
      asPrisma(createPrismaMock()),
    );

    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security_event',
        securityEvent: 'session_revoked_token_used',
        statusCode: 401,
        userId: 'user-1',
        metadata: { sessionId: 'session-1', audience: 'APP' },
      }),
      'SecurityEvent',
    );
  });

  it('marks the revoked-session exception so the filter does not add a generic auth_unauthorized', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const strategy = new JwtStrategy(
      config,
      revocationReturning('revoked'),
      asPrisma(createPrismaMock()),
    );

    const rejection = await strategy.validate(payload).catch((e) => e);

    expect(rejection).toBeInstanceOf(UnauthorizedException);
    expect(wasSecurityEventLogged(rejection)).toBe(true);
  });
});
