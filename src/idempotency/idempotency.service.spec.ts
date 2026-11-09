import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RedisService } from 'src/redis/redis.service';
import { IdempotencyScope, IdempotencyService } from './idempotency.service';

/** RedisService 里幂等用到的三条命令的内存版，语义与 Lua 实现一致。 */
function fakeRedis() {
  const store = new Map<string, string>();
  const redis = {
    store,
    isEnabled: jest.fn(() => true),
    setJsonIfAbsent: jest.fn(async (key: string, value: unknown) => {
      const raw = store.get(key);
      if (raw !== undefined) {
        return { stored: false, current: JSON.parse(raw) };
      }
      store.set(key, JSON.stringify(value));
      return { stored: true };
    }),
    setJson: jest.fn(async (key: string, value: unknown) => {
      store.set(key, JSON.stringify(value));
      return true;
    }),
    releaseLease: jest.fn(async (key: string, expected: string) => {
      if (store.get(key) === expected) store.delete(key);
    }),
  };
  return redis;
}

describe('IdempotencyService', () => {
  const KEY = 'retry_key-0001';
  let redis: ReturnType<typeof fakeRedis>;
  let service: IdempotencyService;

  beforeEach(() => {
    redis = fakeRedis();
    service = new IdempotencyService(redis as unknown as RedisService);
  });

  const request = (
    overrides: Partial<Parameters<IdempotencyService['run']>[0]> = {},
  ) => ({
    scope: IdempotencyScope.CircleCreate,
    userId: 'user-1',
    key: KEY,
    request: { name: 'Circle', tags: ['a', 'b'] },
    ...overrides,
  });

  it('runs the operation untouched when the header is absent (old clients)', async () => {
    const operation = jest.fn().mockResolvedValue({ id: 'circle-1' });

    await expect(
      service.run(request({ key: undefined }), operation),
    ).resolves.toEqual({ id: 'circle-1' });
    await expect(
      service.run(request({ key: undefined }), operation),
    ).resolves.toEqual({ id: 'circle-1' });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(redis.setJsonIfAbsent).not.toHaveBeenCalled();
  });

  it.each([
    ['too short', 'abc1234'],
    ['too long', 'a'.repeat(129)],
    ['spaces', 'retry key 0001'],
    ['punctuation', 'retry/key:0001'],
    ['empty', ''],
  ])(
    'rejects a malformed key (%s) with 400 IDEMPOTENCY_KEY_INVALID before any work',
    async (_label, key) => {
      const operation = jest.fn();

      const error = await service
        .run(request({ key }), operation)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        errorCode: 'IDEMPOTENCY_KEY_INVALID',
      });
      expect(operation).not.toHaveBeenCalled();
      expect(redis.setJsonIfAbsent).not.toHaveBeenCalled();
    },
  );

  it('accepts keys at both length bounds (8 and 128) and UUIDs', async () => {
    const operation = jest.fn().mockResolvedValue({ ok: true });

    for (const key of [
      'Ab_-0123',
      'z'.repeat(128),
      '6f1c2a4e-1b2c-4d3e-8f90-0a1b2c3d4e5f',
    ]) {
      await service.run(request({ key }), operation);
    }

    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('claims the key as pending for 60 s, then keeps the response for 24 h', async () => {
    const response = { id: 'circle-1', createdAt: '2026-11-07T00:00:00.000Z' };

    await expect(service.run(request(), async () => response)).resolves.toBe(
      response,
    );

    const redisKey = `idem:v1:circle-create:user-1:${KEY}`;
    expect(redis.setJsonIfAbsent).toHaveBeenCalledWith(
      redisKey,
      {
        state: 'pending',
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        token: expect.any(String),
      },
      60,
    );
    const pending = redis.setJsonIfAbsent.mock.calls[0][1] as {
      fingerprint: string;
    };
    expect(redis.setJson).toHaveBeenCalledWith(
      redisKey,
      { state: 'done', fingerprint: pending.fingerprint, response },
      24 * 60 * 60,
    );
  });

  it('replays the stored response for the same key and payload without re-running', async () => {
    const operation = jest
      .fn()
      .mockResolvedValueOnce({ id: 'circle-1', name: 'Circle' })
      .mockResolvedValueOnce({ id: 'circle-2', name: 'Circle' });

    const first = await service.run(request(), operation);
    const retry = await service.run(request(), operation);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(retry).toEqual(first);
  });

  it('fingerprints the canonical JSON, so property order does not matter', async () => {
    const operation = jest.fn().mockResolvedValue({ id: 'trace-1' });

    await service.run(
      request({
        request: { traceId: 't-1', body: { content: 'x', images: [] } },
      }),
      operation,
    );
    await service.run(
      request({
        request: { body: { images: [], content: 'x' }, traceId: 't-1' },
      }),
      operation,
    );

    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('refuses a finished key reused for a different payload with 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const operation = jest.fn().mockResolvedValue({ id: 'circle-1' });
    await service.run(request(), operation);

    const error = await service
      .run(
        request({ request: { name: 'Another circle', tags: [] } }),
        operation,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      errorCode: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('answers 409 IDEMPOTENCY_IN_PROGRESS while the first attempt is still running', async () => {
    let finish!: (value: { id: string }) => void;
    const slow = jest.fn(
      () => new Promise<{ id: string }>((resolve) => (finish = resolve)),
    );
    const first = service.run(request(), slow);
    await new Promise((resolve) => setImmediate(resolve));
    expect(slow).toHaveBeenCalledTimes(1);

    const error = await service
      .run(request(), slow)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      errorCode: 'IDEMPOTENCY_IN_PROGRESS',
    });
    finish({ id: 'circle-1' });
    await expect(first).resolves.toEqual({ id: 'circle-1' });
    expect(slow).toHaveBeenCalledTimes(1);
  });

  it('releases its claim when the operation fails, so the client can retry', async () => {
    const failure = new Error('database unavailable');
    const operation = jest
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({ id: 'circle-1' });

    await expect(service.run(request(), operation)).rejects.toBe(failure);
    expect(redis.store.size).toBe(0);
    expect(redis.setJson).not.toHaveBeenCalled();

    await expect(service.run(request(), operation)).resolves.toEqual({
      id: 'circle-1',
    });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('only releases a claim that is still its own', async () => {
    const redisKey = `idem:v1:circle-create:user-1:${KEY}`;
    const failure = new Error('timeout');
    const operation = jest.fn(async () => {
      // 占位已过期，被另一个请求重新占走。
      redis.store.set(
        redisKey,
        JSON.stringify({ state: 'pending', fingerprint: 'f', token: 'other' }),
      );
      throw failure;
    });

    await expect(service.run(request(), operation)).rejects.toBe(failure);

    expect(JSON.parse(redis.store.get(redisKey)!)).toMatchObject({
      token: 'other',
    });
  });

  it('rejects a keyed request with 503 when Redis cannot answer', async () => {
    redis.setJsonIfAbsent.mockResolvedValue(null);
    const warn = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    const operation = jest.fn().mockResolvedValue({ id: 'circle-1' });

    const error = await service
      .run(request(), operation)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      message: '幂等保护暂不可用，请稍后重试',
    });

    expect(operation).not.toHaveBeenCalled();
    expect(redis.setJson).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain('circle-create');
    expect(logged).not.toContain('user-1');
    expect(logged).not.toContain(KEY);
  });

  it('scopes keys by user and by operation', async () => {
    const operation = jest.fn().mockResolvedValue({ id: 'x' });

    await service.run(request(), operation);
    await service.run(request({ userId: 'user-2' }), operation);
    await service.run(
      request({ scope: IdempotencyScope.PlazaPostCreate }),
      operation,
    );

    expect(operation).toHaveBeenCalledTimes(3);
    expect([...redis.store.keys()]).toEqual([
      `idem:v1:circle-create:user-1:${KEY}`,
      `idem:v1:circle-create:user-2:${KEY}`,
      `idem:v1:plaza-post-create:user-1:${KEY}`,
    ]);
  });

  it('gives every endpoint its own scope', () => {
    const scopes = Object.values(IdempotencyScope);

    expect(new Set(scopes).size).toBe(scopes.length);
    // 拼进 idem:v1:<scope>:<userId>:<key>，不能带冒号。
    for (const scope of scopes) expect(scope).toMatch(/^[a-z][a-z-]*$/);
  });
});
