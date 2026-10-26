import { allWithConcurrency } from './concurrency-limit';

/** 手动放行的任务:记录同时在跑的个数。 */
function gate() {
  let running = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const task =
    <T>(value: T) =>
    () => {
      running += 1;
      peak = Math.max(peak, running);
      return new Promise<T>((resolve) => {
        releases.push(() => {
          running -= 1;
          resolve(value);
        });
      });
    };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    task,
    peak: () => peak,
    started: () => releases.length,
    release: async (index: number) => {
      releases[index]();
      await flush();
    },
    flush,
  };
}

describe('allWithConcurrency', () => {
  it('never runs more than the limit at once and keeps result order', async () => {
    const g = gate();
    const result = allWithConcurrency(3, [
      g.task('a'),
      g.task(1),
      g.task(true),
      g.task('d'),
      g.task(null),
    ] as const);
    await g.flush();
    expect(g.started()).toBe(3);

    await g.release(1);
    expect(g.started()).toBe(4);
    await g.release(0);
    await g.release(3);
    await g.release(2);
    await g.release(4);

    await expect(result).resolves.toEqual(['a', 1, true, 'd', null]);
    expect(g.peak()).toBe(3);
  });

  it('starts tasks in the given order', async () => {
    const order: number[] = [];
    await allWithConcurrency(
      2,
      [0, 1, 2, 3].map((i) => async () => {
        order.push(i);
        await Promise.resolve();
        return i;
      }),
    );
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('rejects like Promise.all and starts nothing new after a failure', async () => {
    const g = gate();
    const boom = new Error('boom');
    const result = allWithConcurrency(2, [
      () => Promise.reject(boom),
      g.task('b'),
      g.task('c'),
    ]);

    await expect(result).rejects.toBe(boom);
    await g.flush();
    // 第三个任务不再开跑;已在跑的第二个照常结束,结果丢弃。
    expect(g.started()).toBe(1);
    await g.release(0);
  });

  it('handles an empty list and a limit larger than the list', async () => {
    await expect(allWithConcurrency(3, [])).resolves.toEqual([]);
    await expect(
      allWithConcurrency(10, [async () => 1, async () => 2]),
    ).resolves.toEqual([1, 2]);
  });
});
