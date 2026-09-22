import { ConfigService } from '@nestjs/config';
import {
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtStrategy } from '../auth.strategy';
import type {
  SessionVerdict,
  SessionVerifier,
} from '../session-verifier.service';
import { wasSecurityEventLogged } from 'src/logging/handled-errors';
import {
  getRequestContext,
  runWithRequestContext,
} from 'src/logging/request-context';

function verifierReturning(verdict: SessionVerdict) {
  return {
    verify: jest.fn().mockResolvedValue(verdict),
  } as unknown as SessionVerifier & { verify: jest.Mock };
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
    const verifier = verifierReturning('active');
    const strategy = new JwtStrategy(config, verifier);

    await expect(strategy.validate(payload)).resolves.toEqual({
      userId: 'user-1',
      accountId: 'admin',
      role: 'ADMIN',
      sessionId: 'session-1',
      audience: 'ADMIN',
    });
    expect(verifier.verify).toHaveBeenCalledWith(payload);
  });

  it('rejects a revoked session (F-02) with 401', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const strategy = new JwtStrategy(config, verifierReturning('revoked'));

    await expect(strategy.validate(payload)).rejects.toThrow(
      UnauthorizedException,
    );
    jest.restoreAllMocks();
  });

  // Redis 与数据库都答不上来时，结论是「暂时核验不了」而不是「会话被吊销」。
  // circle-im 的 services/api/client.ts 把 401/403 当成认证结论：先刷新、刷新再
  // 401 就清会话。若这里回 401，一次 Redis+数据库同时抖动会把所有在线用户登出；
  // 503 只让这一次请求失败，登录态保留。
  it('answers 503, not 401, and logs no security event when the session cannot be verified', async () => {
    const strategy = new JwtStrategy(config, verifierReturning('unavailable'));

    const rejection = await strategy
      .validate(payload)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    expect(rejection).not.toBeInstanceOf(UnauthorizedException);
    expect(wasSecurityEventLogged(rejection)).toBe(false);
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
    const strategy = new JwtStrategy(config, verifierReturning('revoked'));

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
    const strategy = new JwtStrategy(config, verifierReturning('revoked'));

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
    const strategy = new JwtStrategy(config, verifierReturning('revoked'));
    await runWithRequestContext(
      { requestId: 'r-2', traceId: 'r-2', method: 'GET', path: '/api/v1/me' },
      async () => {
        const rejection = await strategy.validate(payload).catch((e) => e);

        expect(rejection).toBeInstanceOf(UnauthorizedException);
        expect(wasSecurityEventLogged(rejection)).toBe(true);
      },
    );
  });
});
