import { createRateLimitHandler } from './rate-limit-logger';

function createReq() {
  return {
    method: 'POST',
    originalUrl: '/api/v1/auth/login',
    url: '/api/v1/auth/login',
    ip: '127.0.0.1',
    headers: { 'user-agent': 'jest' },
    user: { userId: 'user-1' },
  } as any;
}

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as any;
}

describe('createRateLimitHandler', () => {
  it('logs rate limit hits without body or credentials', () => {
    const logger = { warn: jest.fn() };
    const handler = createRateLimitHandler(logger as any, {
      enabled: true,
      limiterName: 'auth_login',
      message: { message: 'Too many requests, please try again later.' },
    });
    const req = createReq();
    req.body = { password: 'secret' };
    const res = createRes();

    handler(req, res, undefined, { statusCode: 429 });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'rate_limit_hit',
        limiterName: 'auth_login',
        method: 'POST',
        path: '/api/v1/auth/login',
        userId: 'user-1',
      }),
      'RateLimit',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('secret');
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Too many requests, please try again later.',
    });
  });

  it('preserves response behavior when logging is disabled', () => {
    const logger = { warn: jest.fn() };
    const handler = createRateLimitHandler(logger as any, {
      enabled: false,
      limiterName: 'global',
      message: { message: 'Too many requests' },
    });
    const res = createRes();

    handler(createReq(), res, undefined, { statusCode: 429 });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
