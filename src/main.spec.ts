import {
  buildNestFactoryOptions,
  createGracefulShutdownHandler,
  resolveAppPort,
  resolveCorsOriginChecker,
} from './main';

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
