import { TtlCache } from './ttl-cache';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('TtlCache', () => {
  let clock = 0;
  const cache = (maxEntries = 10) =>
    new TtlCache<string>({ ttlMs: 30_000, maxEntries, now: () => clock });

  beforeEach(() => {
    clock = 1_000_000;
  });

  it('serves a hit inside the TTL without reloading', async () => {
    const c = cache();
    const load = jest.fn().mockResolvedValue('v1');

    await expect(c.getOrLoad('k', load)).resolves.toBe('v1');
    clock += 29_999;
    await expect(c.getOrLoad('k', load)).resolves.toBe('v1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads once the entry has expired', async () => {
    const c = cache();
    const load = jest
      .fn()
      .mockResolvedValueOnce('v1')
      .mockResolvedValueOnce('v2');

    await c.getOrLoad('k', load);
    clock += 30_000;
    await expect(c.getOrLoad('k', load)).resolves.toBe('v2');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keys entries separately', async () => {
    const c = cache();
    await c.getOrLoad('a', () => Promise.resolve('A'));
    await expect(c.getOrLoad('b', () => Promise.resolve('B'))).resolves.toBe(
      'B',
    );
    await expect(c.getOrLoad('a', () => Promise.resolve('x'))).resolves.toBe(
      'A',
    );
  });

  it('drops every entry on clear()', async () => {
    const c = cache();
    await c.getOrLoad('k', () => Promise.resolve('old'));
    c.clear();
    await expect(c.getOrLoad('k', () => Promise.resolve('new'))).resolves.toBe(
      'new',
    );
  });

  // 写路径在加载途中提交并 clear():这次加载读到的可能是写前的数据,不能再写回缓存,
  // 否则写后 30 秒内还在发旧结果。
  it('does not store a load that was already running when clear() happened', async () => {
    const c = cache();
    const slow = deferred<string>();
    const stale = c.getOrLoad('k', () => slow.promise);
    c.clear();
    slow.resolve('before-write');
    await expect(stale).resolves.toBe('before-write');

    await expect(
      c.getOrLoad('k', () => Promise.resolve('after-write')),
    ).resolves.toBe('after-write');
  });

  it('coalesces concurrent misses for the same key into one load', async () => {
    const c = cache();
    const gate = deferred<string>();
    const load = jest.fn(() => gate.promise);

    const first = c.getOrLoad('k', load);
    const second = c.getOrLoad('k', load);
    gate.resolve('shared');

    await expect(Promise.all([first, second])).resolves.toEqual([
      'shared',
      'shared',
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not join a load that started before clear()', async () => {
    const c = cache();
    const slow = deferred<string>();
    void c.getOrLoad('k', () => slow.promise);
    c.clear();
    const fresh = jest.fn().mockResolvedValue('fresh');

    await expect(c.getOrLoad('k', fresh)).resolves.toBe('fresh');
    expect(fresh).toHaveBeenCalledTimes(1);
    slow.resolve('stale');
  });

  it('does not cache failures', async () => {
    const c = cache();
    await expect(
      c.getOrLoad('k', () => Promise.reject(new Error('db down'))),
    ).rejects.toThrow('db down');
    await expect(c.getOrLoad('k', () => Promise.resolve('ok'))).resolves.toBe(
      'ok',
    );
  });

  // 匿名接口的入参(版本号)可以被随意枚举,缓存不能因此无限长大。
  it('caps the number of entries, evicting the oldest', async () => {
    const c = cache(2);
    await c.getOrLoad('a', () => Promise.resolve('A'));
    await c.getOrLoad('b', () => Promise.resolve('B'));
    await c.getOrLoad('c', () => Promise.resolve('C'));

    expect(c.size).toBe(2);
    const reload = jest.fn().mockResolvedValue('A2');
    await expect(c.getOrLoad('a', reload)).resolves.toBe('A2');
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
