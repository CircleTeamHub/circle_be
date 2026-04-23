import { EventEmitter } from 'events';
import { createRequestLoggerMiddleware } from './request-logger.middleware';

function createReq(overrides: Record<string, unknown> = {}) {
  return {
    method: 'GET',
    originalUrl: '/api/v1/user?secret=value',
    url: '/api/v1/user?secret=value',
    ip: '127.0.0.1',
    headers: {
      'user-agent': 'jest',
      authorization: 'Bearer token',
      'x-request-id': 'req-1',
    },
    body: { password: 'secret' },
    ...overrides,
  } as any;
}

function createRes() {
  const res = new EventEmitter() as any;
  res.statusCode = 200;
  res.setHeader = jest.fn();
  res.getHeader = jest.fn((name: string) =>
    name.toLowerCase() === 'content-length' ? '42' : undefined,
  );
  return res;
}

describe('createRequestLoggerMiddleware', () => {
  let dateSpy: jest.SpyInstance<number, []>;

  afterEach(() => {
    dateSpy?.mockRestore();
  });

  it('logs one sanitized access event when the response finishes', () => {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1123);
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const middleware = createRequestLoggerMiddleware(logger, {
      enabled: true,
      slowRequestMs: 1000,
    });
    const req = createReq();
    const res = createRes();
    const next = jest.fn();

    middleware(req, res, next);
    res.emit('finish');

    expect(next).toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'req-1');
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http_access',
        method: 'GET',
        path: '/api/v1/user',
        statusCode: 200,
        durationMs: 123,
        requestId: 'req-1',
      }),
      'HttpAccess',
    );
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('password');
    expect(JSON.stringify(logger.log.mock.calls)).not.toContain('authorization');
  });

  it('logs slow requests as warnings and reads authenticated user at finish time', () => {
    dateSpy = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1600);
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const middleware = createRequestLoggerMiddleware(logger, {
      enabled: true,
      slowRequestMs: 500,
    });
    const req = createReq();
    const res = createRes();

    middleware(req, res, jest.fn());
    req.user = { userId: 'user-1' };
    res.emit('finish');

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'http_slow',
        durationMs: 600,
        userId: 'user-1',
      }),
      'HttpSlow',
    );
  });

  it('passes through without logging when disabled', () => {
    const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const middleware = createRequestLoggerMiddleware(logger, {
      enabled: false,
      slowRequestMs: 500,
    });
    const res = createRes();

    middleware(createReq(), res, jest.fn());
    res.emit('finish');

    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
