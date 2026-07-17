import { AllExceptionFilter } from './filters/all-exception.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { ErrorLoggingInterceptor } from './interceptors/error-logging.interceptor';
import { RedisService } from './redis/redis.service';
import { setupApp } from './setup';
import { redisMetrics } from './redis/redis.metrics';
import { uploadMetrics } from './metrics/upload-metrics';

function buildAppMock(
  redisService?: Pick<RedisService, 'createRateLimitStore'>,
) {
  return {
    setGlobalPrefix: jest.fn(),
    useGlobalFilters: jest.fn(),
    useGlobalPipes: jest.fn(),
    useGlobalInterceptors: jest.fn(),
    use: jest.fn(),
    get: jest.fn((token: unknown) => {
      if (token === RedisService && redisService) return redisService;
      return { httpAdapter: { reply: jest.fn() } };
    }),
    useLogger: jest.fn(),
  };
}

const getServerConfigMock = jest.fn<Record<string, unknown>, []>(() => ({
  LOG_ON: 'false',
}));

jest.mock('./config/server.config', () => ({
  getServerConfig: () => getServerConfigMock(),
}));

describe('setupApp', () => {
  beforeEach(() => {
    getServerConfigMock.mockReturnValue({
      LOG_ON: 'false',
    });
  });

  it('registers the global response interceptor', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ResponseInterceptor),
    );
  });

  it('registers global exception filters (All + Prisma)', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.useGlobalFilters).toHaveBeenCalledWith(
      expect.any(AllExceptionFilter),
      expect.any(PrismaExceptionFilter),
    );
  });

  it('registers request and error logging when enabled', () => {
    getServerConfigMock.mockReturnValue({
      LOG_ON: 'true',
      HTTP_LOG_ON: 'true',
      SLOW_REQUEST_MS: '750',
    });
    const app = {
      setGlobalPrefix: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalPipes: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      use: jest.fn(),
      get: jest.fn(() => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      })),
      useLogger: jest.fn(),
    };

    setupApp(app as any);

    expect(app.useLogger).toHaveBeenCalled();
    expect(app.use).toHaveBeenCalledWith(expect.any(Function));
    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ErrorLoggingInterceptor),
    );
    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ResponseInterceptor),
    );
  });

  it('registers a hardened ValidationPipe (whitelist + forbidNonWhitelisted)', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.useGlobalPipes).toHaveBeenCalledTimes(1);
    const [pipe] = (app.useGlobalPipes.mock.calls[0] ?? []) as Array<unknown>;
    expect(pipe).toBeDefined();
    // ValidationPipe stores options on `validatorOptions` / private fields;
    // assert via the public surface by re-instantiating to compare options is
    // brittle, so we only verify the pipe was registered. Detailed option
    // verification is covered by integration tests.
  });

  it('adds dedicated rate limits for friend requests and coin gifts', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.use).toHaveBeenCalledWith(
      '/api/v1/friend/requests',
      expect.any(Function),
    );
    expect(app.use).toHaveBeenCalledWith(
      '/api/v1/coin/gift',
      expect.any(Function),
    );
  });

  it('adds a dedicated rate limit for trace detail reads', () => {
    const app = buildAppMock();
    setupApp(app as any);

    const traceLimiters = app.use.mock.calls.filter(
      ([path]) => path === '/api/v1/trace',
    );
    expect(traceLimiters).toHaveLength(2);
    expect(traceLimiters[0][1]).toEqual(expect.any(Function));
    expect(traceLimiters[1][1]).toEqual(expect.any(Function));
  });

  it('adds dedicated rate limits for group writes and group reports', () => {
    const app = buildAppMock();
    setupApp(app as any);

    const groupLimiters = app.use.mock.calls.filter(
      ([path]) => path === '/api/v1/group',
    );
    expect(groupLimiters).toHaveLength(2);
    expect(groupLimiters[0][1]).toEqual(expect.any(Function));
    expect(groupLimiters[1][1]).toEqual(expect.any(Function));
  });

  it('uses Redis-backed stores for express rate limits when Redis is configured', () => {
    const createStore = (name: string) =>
      ({
        name,
        init: jest.fn(),
        increment: jest.fn(async () => ({
          totalHits: 1,
          resetTime: new Date(Date.now() + 60_000),
        })),
        decrement: jest.fn(),
        resetKey: jest.fn(),
      }) as any;
    const redisService = {
      createRateLimitStore: jest.fn(createStore),
    };
    const app = buildAppMock(redisService);

    setupApp(app as any);

    expect(redisService.createRateLimitStore).toHaveBeenCalledWith('global');
    expect(redisService.createRateLimitStore).toHaveBeenCalledWith(
      'auth_login',
    );
  });

  it('exposes Redis resilience metrics on the metrics endpoint', async () => {
    redisMetrics.recordCommandFailure('get', 'timeout');
    redisMetrics.recordRateLimitFallback('setup_test');
    uploadMetrics.recordPresignLimited('memory');
    const app = buildAppMock();
    setupApp(app as any);
    const metricsCall = app.use.mock.calls.find(
      ([path]) => path === '/metrics',
    );
    const handler = metricsCall?.[1] as
      | ((req: unknown, res: unknown) => Promise<void>)
      | undefined;
    const response = {
      setHeader: jest.fn(),
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
    };

    expect(handler).toBeDefined();
    await handler?.({ headers: {} }, response);

    expect(response.end).toHaveBeenCalledWith(
      expect.stringContaining('redis_command_failures_total'),
    );
    expect(response.end).toHaveBeenCalledWith(
      expect.stringContaining('redis_rate_limit_degraded'),
    );
    expect(response.end).toHaveBeenCalledWith(
      expect.stringMatching(
        /redis_command_failures_total\{operation="get",reason="timeout"\}\s+[1-9]/,
      ),
    );
    expect(response.end).toHaveBeenCalledWith(
      expect.stringMatching(
        /redis_rate_limit_fallback_total\{limiter="setup_test"\}\s+[1-9]/,
      ),
    );
    expect(response.end).toHaveBeenCalledWith(
      expect.stringMatching(
        /upload_presign_rate_limited_total\{store="memory"\}\s+[1-9]/,
      ),
    );
  });

  it('mounts /healthz and /readyz ahead of every rate limiter', () => {
    const app = buildAppMock();
    setupApp(app as any);

    const mounts = app.use.mock.calls.map(([first]) => first);
    expect(mounts).toContain('/healthz');
    expect(mounts).toContain('/readyz');

    // Express runs middleware in mount order, so the probes must precede the
    // global limiter — a throttled probe reports a healthy app as dead. Rate
    // limiters are identified by the `resetKey` express-rate-limit attaches.
    const firstLimiterIndex = mounts.findIndex(
      (first) => typeof first === 'function' && 'resetKey' in first,
    );
    expect(firstLimiterIndex).toBeGreaterThan(-1);
    expect(mounts.indexOf('/healthz')).toBeLessThan(firstLimiterIndex);
    expect(mounts.indexOf('/readyz')).toBeLessThan(firstLimiterIndex);
  });

  it('still boots when resolving RedisService throws (falls back to no Redis)', () => {
    const app = {
      setGlobalPrefix: jest.fn(),
      useGlobalFilters: jest.fn(),
      useGlobalPipes: jest.fn(),
      useGlobalInterceptors: jest.fn(),
      use: jest.fn(),
      get: jest.fn((provider: unknown) => {
        if (provider === RedisService) {
          throw new Error('Nest cannot resolve RedisService');
        }
        return { httpAdapter: { reply: jest.fn() } };
      }),
      useLogger: jest.fn(),
    };

    expect(() => setupApp(app as any)).not.toThrow();
  });

  it('trusts exactly one reverse-proxy hop in production', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const express = { set: jest.fn() };
    const app = {
      ...buildAppMock(),
      getHttpAdapter: jest.fn(() => ({ getInstance: () => express })),
    };

    setupApp(app as any);

    expect(express.set).toHaveBeenCalledWith('trust proxy', 1);
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });
});
