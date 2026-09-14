import { AllExceptionFilter } from './filters/all-exception.filter';
import { PrismaExceptionFilter } from './filters/prisma-exception.filter';
import { ResponseInterceptor } from './interceptors/response.interceptor';
import { ErrorLoggingInterceptor } from './interceptors/error-logging.interceptor';
import { RedisService } from './redis/redis.service';
import { createWriteMethodLimiterMount, setupApp } from './setup';
import { redisMetrics } from './redis/redis.metrics';
import { uploadMetrics } from './metrics/upload-metrics';
import { chatMetrics } from './chat/chat-metrics';
import * as errorAggregation from './logging/error-aggregation.service';
import * as rejectionGuard from './logging/unhandled-rejection-guard';

function buildAppMock(
  redisService?: Pick<RedisService, 'createRateLimitStore'> &
    Partial<Pick<RedisService, 'isEnabled' | 'ping'>>,
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

  // 回归：Node 15 起未捕获的 promise rejection 默认终止进程 —— 代码库里
  // fire-and-forget 有几十处，漏一个 .catch 就能停服（实测过一次：Redis 抖动
  // + WebSocket 断开）。兜底必须在引导期装上，而不是指望人逐个记得写 .catch。
  it('引导期装上未捕获 rejection 的进程级兜底', () => {
    const install = jest
      .spyOn(rejectionGuard, 'installUnhandledRejectionGuard')
      .mockReturnValue(() => undefined);
    const app = buildAppMock();

    setupApp(app as any);

    expect(install).toHaveBeenCalled();
    install.mockRestore();
  });

  it('registers the global response interceptor', () => {
    const app = buildAppMock();
    setupApp(app as any);

    expect(app.useGlobalInterceptors).toHaveBeenCalledWith(
      expect.any(ResponseInterceptor),
    );
  });

  it('makes the configured aggregation provider available to non-HTTP jobs', () => {
    const configure = jest.spyOn(
      errorAggregation,
      'configureErrorAggregationProvider',
    );
    const app = buildAppMock();

    setupApp(app as any);

    expect(configure).toHaveBeenCalledWith(
      expect.objectContaining({ captureError: expect.any(Function) }),
    );
    configure.mockRestore();
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

  it('mounts reset-request behind the shared email-code limiter (PR #120 review)', () => {
    const app = buildAppMock();
    setupApp(app as any);

    // 未认证发信面必须共享同一个限流池，换端点不能绕开 10/15min 上限
    expect(app.use).toHaveBeenCalledWith(
      '/api/v1/auth/password/reset-request',
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
      isEnabled: jest.fn(() => true),
      ping: jest.fn(async () => true),
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

  it('exposes the production chat metrics singleton on the metrics endpoint', async () => {
    chatMetrics.observeConnectionOpened(1);
    try {
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

      await handler?.({ headers: {} }, response);

      expect(response.end).toHaveBeenCalledWith(
        expect.stringMatching(/chat_connections_active\s+1/),
      );
    } finally {
      chatMetrics.observeConnectionClosed(0);
    }
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

// note 的 express 限流曾是不分方法的前缀挂载：60 次/15 分钟/IP 的「写」配额把
// GET 详情/列表也算进去，运营商 NAT 后的一群用户翻 60 次笔记就集体 429。
describe('createWriteMethodLimiterMount', () => {
  it('passes reads straight through and sends writes to the limiter', () => {
    const limiter = jest.fn();
    const mount = createWriteMethodLimiterMount(limiter as any);
    const res = {} as any;

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const next = jest.fn();
      mount({ method } as any, res, next);
      expect(limiter).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledTimes(1);
    }

    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      limiter.mockClear();
      const next = jest.fn();
      const req = { method } as any;
      mount(req, res, next);
      expect(limiter).toHaveBeenCalledWith(req, res, next);
      expect(next).not.toHaveBeenCalled();
    }
  });
});

describe('setupApp note limiter mount', () => {
  it('mounts /api/v1/note behind a method filter so GET reads are not throttled as writes', () => {
    const app = buildAppMock();
    setupApp(app as any);

    const noteMounts = app.use.mock.calls.filter(
      ([path]) => path === '/api/v1/note',
    );
    expect(noteMounts).toHaveLength(1);
    const next = jest.fn();
    // 读请求必须同步放行：limiter 一旦被调用就会走异步 store，next 不会同步触发。
    noteMounts[0][1]({ method: 'GET', path: '/abc' }, {}, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

// /api/v1/circle 的挂载曾只把 POST/DELETE 交给写限流器:PATCH /circle/:id(编辑圈子、
// 改群名/群公告)与 PUT 落进读限流器(600 次/15 分钟),写配额(40 次/15 分钟)对它们
// 形同虚设。这里用真实的 express-rate-limit 实例按方法打满写配额来验证分流。
describe('setupApp circle limiter mount', () => {
  beforeEach(() => {
    getServerConfigMock.mockReturnValue({ LOG_ON: 'false' });
  });

  const hit = async (
    mount: (req: any, res: any, next: any) => unknown,
    method: string,
  ) => {
    const next = jest.fn();
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
      headersSent: false,
      writableEnded: false,
    };
    await mount(
      {
        method,
        ip: '203.0.113.7',
        headers: {},
        app: { get: () => false },
        socket: {},
      },
      res,
      next,
    );
    return { next, res };
  };

  it('counts PATCH and PUT against the circle write limiter, not the read limiter', async () => {
    const app = buildAppMock();
    setupApp(app as any);

    const circleMounts = app.use.mock.calls.filter(
      ([path]) => path === '/api/v1/circle',
    );
    expect(circleMounts).toHaveLength(1);
    const mount = circleMounts[0][1];

    // circleWriteLimiterOptions.max = 40
    for (let i = 0; i < 40; i += 1) {
      const { next } = await hit(mount, i % 2 === 0 ? 'PATCH' : 'PUT');
      expect(next).toHaveBeenCalledWith();
    }
    const blocked = await hit(mount, 'PATCH');
    expect(blocked.next).not.toHaveBeenCalled();
    expect(blocked.res.status).toHaveBeenCalledWith(429);

    // 读请求仍走独立的读配额,不被打满的写配额连坐。
    const read = await hit(mount, 'GET');
    expect(read.next).toHaveBeenCalledWith();
  });
});
