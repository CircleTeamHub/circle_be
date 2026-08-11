import { createDbPoolMetrics, type PoolStats } from './db-pool.metrics';

function read(text: string, name: string): number | undefined {
  const match = text.match(new RegExp(`^${name}\\s+(-?[0-9.e+]+)$`, 'm'));
  return match ? Number(match[1]) : undefined;
}

describe('createDbPoolMetrics', () => {
  it('exposes the live pool counters at scrape time', async () => {
    let stats: PoolStats | null = { max: 10, total: 7, idle: 2, waiting: 3 };
    const metrics = createDbPoolMetrics(() => stats);

    const text = await metrics.registry.metrics();
    expect(read(text, 'circle_db_pool_max')).toBe(10);
    expect(read(text, 'circle_db_pool_total')).toBe(7);
    expect(read(text, 'circle_db_pool_idle')).toBe(2);
    expect(read(text, 'circle_db_pool_waiting')).toBe(3);

    // 抓取时求值：下一次抓取必须看到新数字，而不是第一次的快照。
    stats = { max: 10, total: 10, idle: 0, waiting: 12 };
    const next = await metrics.registry.metrics();
    expect(read(next, 'circle_db_pool_waiting')).toBe(12);
    expect(read(next, 'circle_db_pool_idle')).toBe(0);
  });

  it('registers nothing when there is no pool', async () => {
    // 允许无 DATABASE_URL 启动（allowsStartWithoutDatabase）。那时没有池，
    // 与其让四条 gauge 恒为 0（看起来像「池很空闲」），不如让序列不存在。
    const metrics = createDbPoolMetrics(() => null);

    const text = await metrics.registry.metrics();
    expect(text).not.toContain('circle_db_pool_max');
    expect(text).not.toContain('circle_db_pool_waiting');
  });

  it('keeps reporting zero waiters rather than dropping the series', async () => {
    // waiting=0 是常态。如果这时不写这条序列，`> 0` 的告警在队列排空后
    // 会失去 resolved 信号,并且大盘上会出现断线。
    const metrics = createDbPoolMetrics(() => ({
      max: 10,
      total: 3,
      idle: 3,
      waiting: 0,
    }));

    const text = await metrics.registry.metrics();
    expect(read(text, 'circle_db_pool_waiting')).toBe(0);
  });

  it('survives a probe that starts throwing instead of breaking the whole scrape', async () => {
    // /metrics 是合并注册表：这里抛出去会让 RED、事件循环、chat 延迟一起
    // 500，恰好在数据库出问题的时候。
    let broken = false;
    const metrics = createDbPoolMetrics(() => {
      if (broken) throw new Error('pool inspection failed');
      return { max: 10, total: 4, idle: 1, waiting: 2 };
    });

    expect(
      read(await metrics.registry.metrics(), 'circle_db_pool_waiting'),
    ).toBe(2);

    broken = true;
    const text = await metrics.registry.metrics();
    // 不抛、不 500；保留上一次读数，其余指标照常输出。
    expect(read(text, 'circle_db_pool_waiting')).toBe(2);
  });

  it('registers nothing when the very first probe throws', async () => {
    const metrics = createDbPoolMetrics(() => {
      throw new Error('no pool');
    });

    expect(await metrics.registry.metrics()).not.toContain(
      'circle_db_pool_max',
    );
  });
});
