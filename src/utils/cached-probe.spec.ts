import { createCachedProbe } from './cached-probe';

describe('createCachedProbe', () => {
  let now = 0;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('reuses a fresh result instead of calling the dependency on every probe', async () => {
    // /readyz 被容器健康检查和 Prometheus 抓取反复调用：不缓存的话每次都打一遍
    // 云存储。
    const check = jest.fn(async () => true);
    const probe = createCachedProbe(check, {
      ttlMs: 30_000,
      timeoutMs: 2_000,
      now: clock,
    });

    await expect(probe()).resolves.toBe(true);
    now += 29_999;
    await expect(probe()).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(1);

    now += 1;
    await probe();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight check between concurrent callers', async () => {
    let release = (_value: boolean) => {};
    const check = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const probe = createCachedProbe(check, {
      ttlMs: 30_000,
      timeoutMs: 2_000,
      now: clock,
    });

    const first = probe();
    const second = probe();
    release(true);

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('reports down when the check throws', async () => {
    const probe = createCachedProbe(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      { ttlMs: 30_000, timeoutMs: 2_000, now: clock },
    );

    await expect(probe()).resolves.toBe(false);
  });

  it('reports down and aborts the check when it outlives the timeout', async () => {
    jest.useFakeTimers();
    try {
      let aborted = false;
      const probe = createCachedProbe(
        (signal) =>
          new Promise<boolean>(() => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
          }),
        { ttlMs: 30_000, timeoutMs: 2_000, now: clock },
      );

      const result = probe();
      jest.advanceTimersByTime(2_000);

      await expect(result).resolves.toBe(false);
      expect(aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
