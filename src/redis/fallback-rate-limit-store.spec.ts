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
    await store.increment('ip-1'); // primary healthy again → recover

    expect(logger.log).toHaveBeenCalledTimes(1);
  });
});
