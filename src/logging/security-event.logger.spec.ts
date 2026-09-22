import { logSecurityEvent } from './security-event.logger';
import { runWithRequestContext } from './request-context';

describe('logSecurityEvent', () => {
  it('logs security events with request context', () => {
    const logger = { warn: jest.fn() };

    runWithRequestContext(
      {
        requestId: 'req-1',
        traceId: 'req-1',
        method: 'GET',
        path: '/api/v1/auth/me',
        ip: '127.0.0.1',
        userAgent: 'jest',
        userId: 'user-1',
      },
      () =>
        logSecurityEvent(logger as any, {
          enabled: true,
          securityEvent: 'access_forbidden',
          statusCode: 403,
          reason: 'forbidden',
        }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security_event',
        securityEvent: 'access_forbidden',
        requestId: 'req-1',
        method: 'GET',
        path: '/api/v1/auth/me',
        userId: 'user-1',
        statusCode: 403,
      }),
      'SecurityEvent',
    );
  });

  it('redacts sensitive values from reason and metadata', () => {
    const logger = { warn: jest.fn() };

    logSecurityEvent(logger as any, {
      enabled: true,
      securityEvent: 'auth_unauthorized',
      reason: 'jwt token=abc123',
      metadata: {
        token: 'abc123',
        hint: 'authorization=Bearer foo',
      },
    });

    const payload = logger.warn.mock.calls[0][0];
    expect(payload.reason).toBe('jwt token=[redacted]');
    expect(payload.metadata.token).toBe('[redacted]');
    expect(payload.metadata.hint).toBe('authorization=[redacted]');
  });

  it('does not expose IP addresses or nested contacts with an alternate logger', () => {
    const logger = { warn: jest.fn() };
    runWithRequestContext(
      {
        requestId: 'req-1',
        traceId: 'req-1',
        method: 'GET',
        path: '/unknown/private-path',
        ip: 'private-ip',
      },
      () => {
        logSecurityEvent(logger as any, {
          enabled: true,
          securityEvent: 'access_forbidden',
          metadata: { nested: { email: 'private-email@example.com' } },
        });
      },
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-');
    expect(logger.warn.mock.calls[0][0].path).toBe('/__other__');
  });
});
