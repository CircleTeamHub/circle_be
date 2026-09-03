import { ConfigService } from '@nestjs/config';
import { UnauthorizedException, Logger } from '@nestjs/common';
import { JwtStrategy } from '../auth.strategy';
import type { SessionRevocationService } from '../session-revocation.service';
import {
  getRequestContext,
  runWithRequestContext,
} from 'src/logging/request-context';

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
    const revocation = {
      isRevoked: jest.fn().mockResolvedValue(false),
    } as unknown as SessionRevocationService;
    const strategy = new JwtStrategy(config, revocation);

    await expect(strategy.validate(payload)).resolves.toEqual({
      userId: 'user-1',
      accountId: 'admin',
      role: 'ADMIN',
      sessionId: 'session-1',
      audience: 'ADMIN',
    });
  });

  it('rejects a revoked session (F-02)', async () => {
    const revocation = {
      isRevoked: jest.fn().mockResolvedValue(true),
    } as unknown as SessionRevocationService;
    const strategy = new JwtStrategy(config, revocation);

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
    const revocation = {
      isRevoked: jest.fn().mockResolvedValue(true),
    } as unknown as SessionRevocationService;
    const strategy = new JwtStrategy(config, revocation);

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
    const revocation = {
      isRevoked: jest.fn().mockResolvedValue(true),
    } as unknown as SessionRevocationService;
    const strategy = new JwtStrategy(config, revocation);

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
});
