import {
  buildNestFactoryOptions,
  createGracefulShutdownHandler,
  resolveAppPort,
  resolveCorsOriginChecker,
  runBootstrap,
} from './main';
import {
  Controller,
  Get,
  INestApplication,
  Module,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';

@Controller('cors-probe')
class CorsProbeController {
  @Get()
  probe() {
    return { ok: true };
  }
}

@Module({ controllers: [CorsProbeController] })
class CorsProbeModule {}

function checkOrigin(
  env: NodeJS.ProcessEnv,
  origin: string | undefined,
): boolean {
  const callback = jest.fn();
  resolveCorsOriginChecker(env)(origin, callback);
  const [error, allow] = callback.mock.calls[0] as [Error | null, boolean?];
  return error === null && allow === true;
}

describe('resolveCorsOriginChecker', () => {
  // The regression this guards: the checker is built by buildNestFactoryOptions()
  // while evaluating the arguments to NestFactory.create(), i.e. before
  // ConfigModule loads .env.<NODE_ENV> into process.env. An eager read captured
  // an empty allowlist and blocked every browser origin in production.
  it('honors ALLOWED_ORIGINS set after the checker was built', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    const checker = resolveCorsOriginChecker(env);

    const before = jest.fn();
    checker('https://app.example.com', before);
    expect(before.mock.calls[0][0]).toBeInstanceOf(Error);

    env.ALLOWED_ORIGINS = 'https://app.example.com';

    const after = jest.fn();
    checker('https://app.example.com', after);
    expect(after).toHaveBeenCalledWith(null, true);
  });

  it('allows requests without an Origin header (curl, mobile webviews)', () => {
    expect(checkOrigin({ NODE_ENV: 'production' }, undefined)).toBe(true);
  });

  it('allows exactly the configured origins, trimming the list', () => {
    const env = {
      NODE_ENV: 'production',
      ALLOWED_ORIGINS: 'https://a.example.com , https://b.example.com',
    };

    expect(checkOrigin(env, 'https://a.example.com')).toBe(true);
    expect(checkOrigin(env, 'https://b.example.com')).toBe(true);
    expect(checkOrigin(env, 'https://evil.example.com')).toBe(false);
  });

  it('allows localhost/LAN origins outside production only', () => {
    expect(
      checkOrigin({ NODE_ENV: 'development' }, 'http://localhost:8081'),
    ).toBe(true);
    expect(
      checkOrigin({ NODE_ENV: 'development' }, 'http://192.168.1.20:8081'),
    ).toBe(true);
    expect(
      checkOrigin({ NODE_ENV: 'production' }, 'http://localhost:8081'),
    ).toBe(false);
  });

  it('re-reads NODE_ENV per request, so dev patterns cannot leak into production', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'development' };
    const checker = resolveCorsOriginChecker(env);

    const dev = jest.fn();
    checker('http://localhost:3000', dev);
    expect(dev).toHaveBeenCalledWith(null, true);

    env.NODE_ENV = 'production';

    const prod = jest.fn();
    checker('http://localhost:3000', prod);
    expect(prod.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('production HTTP CORS integration', () => {
  let app: INestApplication;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllowedOrigins = process.env.ALLOWED_ORIGINS;

  beforeAll(async () => {
    process.env.NODE_ENV = 'production';
    process.env.ALLOWED_ORIGINS = 'https://web.example.test';
    app = await NestFactory.create(CorsProbeModule, {
      ...buildNestFactoryOptions(),
      logger: false,
    });
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAllowedOrigins === undefined)
      delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = previousAllowedOrigins;
  });

  it('emits credentialed preflight headers only for the configured web origin', async () => {
    const allowed = await request(app.getHttpServer())
      .options('/cors-probe')
      .set('Origin', 'https://web.example.test')
      .set('Access-Control-Request-Method', 'GET');

    expect(allowed.status).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe(
      'https://web.example.test',
    );
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');

    const blocked = await request(app.getHttpServer())
      .options('/cors-probe')
      .set('Origin', 'https://evil.example.test')
      .set('Access-Control-Request-Method', 'GET');

    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('resolveAppPort', () => {
  it('rejects malformed port strings', () => {
    expect(() => resolveAppPort('3000{')).toThrow('Invalid APP_PORT value');
  });

  it('accepts numeric strings', () => {
    expect(resolveAppPort('3000')).toBe(3000);
  });
});

describe('buildNestFactoryOptions', () => {
  it('enables raw body support for signed webhooks', () => {
    expect(buildNestFactoryOptions().rawBody).toBe(true);
  });

  // GET /note 与 /note/recycle-bin 用 X-Has-More 告知截断（响应体保持数组）。移动端
  // 不受 CORS 约束，但浏览器跨域时读不到未列入 Access-Control-Expose-Headers 的头。
  it('exposes the X-Has-More pagination header to browser clients', () => {
    expect(buildNestFactoryOptions().cors.exposedHeaders).toEqual(
      expect.arrayContaining(['X-Has-More']),
    );
  });

  it('exposes the X-Request-Id correlation header to browser clients', () => {
    expect(buildNestFactoryOptions().cors.exposedHeaders).toEqual(
      expect.arrayContaining(['X-Request-Id']),
    );
  });
});

describe('createGracefulShutdownHandler', () => {
  it('closes the app, then flushes error aggregation, then exits — in order', async () => {
    const calls: string[] = [];
    const app = {
      close: jest.fn(async () => {
        calls.push('close');
      }),
    };
    const errorAggregation = {
      flush: jest.fn(async () => {
        calls.push('flush');
        return true;
      }),
    };
    const onExit = jest.fn(() => calls.push('exit'));

    await createGracefulShutdownHandler(app, errorAggregation, onExit, 2000)();

    expect(calls).toEqual(['close', 'flush', 'exit']);
    expect(errorAggregation.flush).toHaveBeenCalledWith(2000);
  });

  it('still flushes and exits when app.close() throws', async () => {
    const app = { close: jest.fn().mockRejectedValue(new Error('close boom')) };
    const errorAggregation = { flush: jest.fn().mockResolvedValue(true) };
    const onExit = jest.fn();

    await createGracefulShutdownHandler(app, errorAggregation, onExit)();

    expect(errorAggregation.flush).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second signal does not close/flush/exit again', async () => {
    const app = { close: jest.fn().mockResolvedValue(undefined) };
    const errorAggregation = { flush: jest.fn().mockResolvedValue(true) };
    const onExit = jest.fn();

    const shutdown = createGracefulShutdownHandler(
      app,
      errorAggregation,
      onExit,
    );
    await shutdown();
    await shutdown();

    expect(app.close).toHaveBeenCalledTimes(1);
    expect(errorAggregation.flush).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });
});

describe('runBootstrap', () => {
  function recordingSinks() {
    const calls: string[] = [];
    const logged: string[] = [];
    return {
      calls,
      logged,
      logError: jest.fn((message: string) => {
        calls.push('log');
        logged.push(message);
      }),
      exit: jest.fn((code: number) => {
        calls.push(`exit:${code}`);
      }),
    };
  }

  it('safe-logs startup failure without private exception prose, then exits non-zero', async () => {
    // The test server on 2026-09-18: an external bucket without a delivery URL
    // makes UploadService.onModuleInit throw inside app.init(). The rejection
    // used to land in the unhandled-rejection guard, which only reports it, so
    // the process stayed up with no listener and not a single log line.
    const failure = new ServiceUnavailableException(
      'External media must use an explicitly configured rate-limited delivery URL',
    );
    const sinks = recordingSinks();
    const errorAggregation = {
      captureError: jest.fn(),
      flush: jest.fn().mockResolvedValue(true),
    };

    await runBootstrap(() => Promise.reject(failure), sinks, errorAggregation);

    expect(sinks.calls).toEqual(['log', 'exit:1']);
    expect(errorAggregation.captureError).toHaveBeenCalledTimes(1);
    expect(errorAggregation.flush).toHaveBeenCalledWith(2000);
    expect(sinks.logged[0]).toContain(
      '[bootstrap] Application failed to start; errorName=ServiceUnavailableException',
    );
    expect(sinks.logged[0]).not.toContain('External media');
  });

  it('leaves a successful start alone', async () => {
    const sinks = recordingSinks();

    await runBootstrap(() => Promise.resolve(), sinks);

    expect(sinks.logError).not.toHaveBeenCalled();
    expect(sinks.exit).not.toHaveBeenCalled();
  });

  it('is fatal for a rejection that is not an Error', async () => {
    const sinks = recordingSinks();

    await runBootstrap(() => Promise.reject('APP_PORT missing'), sinks);

    expect(sinks.logged[0]).not.toContain('APP_PORT missing');
    expect(sinks.exit).toHaveBeenCalledWith(1);
  });

  it('still exits when the log line itself cannot be written', async () => {
    const sinks = recordingSinks();
    sinks.logError.mockImplementation(() => {
      throw new Error('stderr closed');
    });

    await runBootstrap(() => Promise.reject(new Error('boom')), sinks);

    expect(sinks.exit).toHaveBeenCalledWith(1);
  });

  it('still logs and exits when startup error aggregation throws', async () => {
    const sinks = recordingSinks();
    const aggregation = {
      captureError: jest.fn(() => {
        throw new Error('capture failed');
      }),
      flush: jest.fn(() => {
        throw new Error('flush failed');
      }),
    };

    await runBootstrap(
      () => Promise.reject(new TypeError('private startup error')),
      sinks,
      aggregation,
    );

    expect(sinks.logged[0]).toContain('errorName=TypeError');
    expect(sinks.logged[0]).not.toContain('private startup error');
    expect(sinks.exit).toHaveBeenCalledWith(1);
  });

  it('exits after the hard deadline when startup aggregation flush hangs', async () => {
    jest.useFakeTimers();
    const sinks = recordingSinks();
    const aggregation = {
      captureError: jest.fn(),
      flush: jest.fn(() => new Promise<boolean>(() => undefined)),
    };
    const startup = runBootstrap(
      () => Promise.reject(new Error('private startup error')),
      sinks,
      aggregation,
    );

    await jest.advanceTimersByTimeAsync(1999);
    expect(sinks.exit).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await startup;
    expect(sinks.exit).toHaveBeenCalledWith(1);
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
