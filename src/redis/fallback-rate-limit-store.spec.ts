import type { Options, Store } from 'express-rate-limit';
import { FallbackRateLimitStore } from './fallback-rate-limit-store';

describe('FallbackRateLimitStore', () => {
  const options = { windowMs: 60_000 } as unknown as Options;
  const silentLogger = { warn: jest.fn(), log: jest.fn() };

  function makePrimary(overrides: Partial<Store> = {}): Store {
    return {
      init: jest.fn(),
      increment: jest.fn(),
      decrement: jest.fn(),
      resetKey: jest.fn(),
      resetAll: jest.fn(),
      ...overrides,
    } as Store;
  }

  beforeEach(() => jest.clearAllMocks());

  it('uses the primary (Redis) store while it is healthy', async () => {
    const primary = makePrimary({
      increment: jest.fn(async () => ({ totalHits: 5, resetTime: new Date() })),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
    );
    store.init(options);

    const result = await store.increment('ip-1');

    expect(result.totalHits).toBe(5);
    expect(primary.increment).toHaveBeenCalledWith('ip-1');
  });

  it('fails over to in-memory counting when the primary throws (never fails open)', async () => {
    const primary = makePrimary({
      increment: jest.fn(async () => {
        throw new Error('Redis is not configured');
      }),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
    );
    store.init(options);

    // MemoryStore returns a shared mutable record, so snapshot totalHits now.
    const firstHits = (await store.increment('ip-1')).totalHits;
    const secondHits = (await store.increment('ip-1')).totalHits;

    // Keeps counting per-instance instead of returning nothing / allowing all.
    expect(firstHits).toBe(1);
    expect(secondHits).toBe(2);
  });

  it('logs the degradation only once per outage', async () => {
    const logger = { warn: jest.fn(), log: jest.fn() };
    const primary = makePrimary({
      increment: jest.fn(async () => {
        throw new Error('down');
      }),
    });
    const store = new FallbackRateLimitStore(primary, 'auth_login', logger);
    store.init(options);

    await store.increment('ip-1');
    await store.increment('ip-1');

    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('logs recovery once the primary store comes back', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let healthy = false;
    const logger = { warn: jest.fn(), log: jest.fn() };
    const primary = makePrimary({
      increment: jest.fn(async () => {
        if (!healthy) {
          throw new Error('down');
        }
        return { totalHits: 1, resetTime: new Date() };
      }),
    });
    const store = new FallbackRateLimitStore(primary, 'auth_login', logger);
    store.init(options);

    await store.increment('ip-1'); // degrade → memory
    healthy = true;
    now += 2_000;
    await store.increment('ip-1'); // primary healthy again → recover

    expect(logger.log).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it('records every fallback request and only state transitions', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let healthy = false;
    const metrics = {
      recordRateLimitFallback: jest.fn(),
      setRateLimitDegraded: jest.fn(),
    };
    const primary = makePrimary({
      increment: jest.fn(async () => {
        if (!healthy) throw new Error('down');
        return { totalHits: 1, resetTime: new Date() };
      }),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
      metrics,
    );
    store.init(options);

    await store.increment('ip-1');
    await store.increment('ip-1');
    healthy = true;
    now += 2_000;
    await store.increment('ip-1');

    expect(metrics.recordRateLimitFallback).toHaveBeenCalledTimes(2);
    expect(metrics.recordRateLimitFallback).toHaveBeenCalledWith('auth_login');
    expect(metrics.setRateLimitDegraded.mock.calls).toEqual([
      ['auth_login', true],
      ['auth_login', false],
    ]);
    nowSpy.mockRestore();
  });

  it('handles asynchronous primary initialization failure without rejecting', async () => {
    const primary = makePrimary({
      init: jest.fn().mockRejectedValue(new Error('script load failed')),
      increment: jest.fn(),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
    );

    expect(() => store.init(options)).not.toThrow();
    await expect(store.increment('ip-1')).resolves.toMatchObject({
      totalHits: 1,
    });
    expect(primary.increment).not.toHaveBeenCalled();
  });

  it('serves memory immediately while asynchronous primary initialization is pending', async () => {
    const metrics = {
      recordRateLimitFallback: jest.fn(),
      setRateLimitDegraded: jest.fn(),
    };
    const primary = makePrimary({
      init: jest.fn(() => new Promise<void>(() => undefined)) as any,
      increment: jest.fn(),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
      metrics,
    );
    store.init(options);

    await expect(store.increment('ip-1')).resolves.toMatchObject({
      totalHits: 1,
    });
    expect(primary.increment).not.toHaveBeenCalled();
    expect(metrics.setRateLimitDegraded).toHaveBeenCalledWith(
      'auth_login',
      true,
    );
  });

  it('does not let a stale healthy call close a breaker opened by a newer failure', async () => {
    let resolveFirst!: (value: { totalHits: number; resetTime: Date }) => void;
    let rejectSecond!: (error: Error) => void;
    const first = new Promise<{ totalHits: number; resetTime: Date }>(
      (resolve) => (resolveFirst = resolve),
    );
    const second = new Promise<{ totalHits: number; resetTime: Date }>(
      (_resolve, reject) => (rejectSecond = reject),
    );
    const metrics = {
      recordRateLimitFallback: jest.fn(),
      setRateLimitDegraded: jest.fn(),
    };
    const primary = makePrimary({
      increment: jest
        .fn()
        .mockReturnValueOnce(first)
        .mockReturnValueOnce(second),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
      metrics,
    );
    store.init(options);

    const staleSuccess = store.increment('ip-1');
    const newerFailure = store.increment('ip-2');
    rejectSecond(new Error('down'));
    await newerFailure;
    resolveFirst({ totalHits: 1, resetTime: new Date() });
    await staleSuccess;
    await store.increment('ip-3');

    expect(primary.increment).toHaveBeenCalledTimes(2);
    expect(metrics.setRateLimitDegraded.mock.calls).toEqual([
      ['auth_login', true],
    ]);
  });

  it('uses a half-open circuit breaker instead of retrying Redis on every request', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    let healthy = false;
    const primary = makePrimary({
      increment: jest.fn(async () => {
        if (!healthy) throw new Error('down');
        return { totalHits: 1, resetTime: new Date() };
      }),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
    );
    store.init(options);

    await store.increment('ip-1');
    await store.increment('ip-2');
    expect(primary.increment).toHaveBeenCalledTimes(1);

    now += 2_000;
    healthy = true;
    const results = await Promise.all([
      store.increment('ip-3'),
      store.increment('ip-4'),
      store.increment('ip-5'),
    ]);

    expect(primary.increment).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(3);
    nowSpy.mockRestore();
  });

  it('bounds concurrent primary requests during the first outage wave', async () => {
    let rejectPrimary!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => {
      rejectPrimary = reject;
    });
    const primary = makePrimary({
      increment: jest.fn(() => pending),
    });
    const store = new FallbackRateLimitStore(
      primary,
      'auth_login',
      silentLogger,
    );
    store.init(options);

    const requests = Array.from({ length: 100 }, (_, index) =>
      store.increment(`ip-${index}`),
    );
    await Promise.resolve();
    expect(primary.increment).toHaveBeenCalledTimes(32);

    rejectPrimary(new Error('down'));
    const results = await Promise.all(requests);
    expect(results).toHaveLength(100);
    expect(
      results.filter((result) => result.totalHits === Number.MAX_SAFE_INTEGER),
    ).toHaveLength(68);
  });
});
