import { Gauge, Registry } from 'prom-client';

/** node-postgres 池的实时读数。全部来自内存计数器，读它不产生任何 I/O。 */
export interface PoolStats {
  /** 配置上限（DATABASE_POOL_MAX，默认 10）。 */
  max: number;
  /** 已建立的连接数（含空闲）。 */
  total: number;
  /** 空闲连接数。 */
  idle: number;
  /** **正在排队等连接的请求数** —— 池耗尽的确定信号。 */
  waiting: number;
}

export type PoolStatsProbe = () => PoolStats | null;

/**
 * 连接池指标。
 *
 * 这是 postgres-exporter **看不到**的那一面：池排队发生在 Node 进程内部，
 * 从 Postgres 的视角一切正常 —— 连接数没涨、没有慢查询、没有锁等待，而应用
 * 侧的请求已经在 `connectionTimeoutMillis`（10s）上排队，超时后才变成 5xx。
 * 等 BackendHighLatencyP95 响的时候早就晚了。
 *
 * 之所以能拿到精确数字而不是估算：本项目用 `@prisma/adapter-pg`，底下是真正的
 * node-postgres `Pool`，`waitingCount` 就是「有多少请求在等连接」。（Prisma 自带
 * 的 `$metrics` 在 Prisma 7 已被移除，`previewFeatures = ["metrics"]` 会直接
 * 报 P1012 —— 不要再去试那条路。）
 *
 * 用 `collect()` 抓取时求值是安全的：读的是内存计数器，不像 outbox 深度那样需要
 * 查库，所以不会让 `/metrics` 的延迟绑上数据库健康。
 */
export function createDbPoolMetrics(probe: PoolStatsProbe): {
  registry: Registry;
} {
  const registry = new Registry();

  // 有没有池是在构造期就定下的：@prisma/adapter-pg 的 Pool 随 PrismaService
  // 构造函数一起创建（有 connectionString 时），之后不会凭空出现。
  //
  // 没有池就**一条都不注册**，而不是注册后恒 0 —— 无标签 gauge 即便 reset()
  // 也照样输出 `0`，大盘上读起来像「池很空闲」，恰好是相反的结论。这和
  // infra-status.metrics 里「Redis 未配置就不挂 circle_redis_up，免得 gauge
  // 恒 0、RedisDown 对着一个不存在的依赖长鸣」是同一个判断。
  let hasPool = false;
  try {
    hasPool = probe() !== null;
  } catch {
    hasPool = false;
  }
  if (!hasPool) {
    return { registry };
  }

  const gauge = (name: string, help: string, pick: (s: PoolStats) => number) =>
    new Gauge({
      name,
      help,
      registers: [registry],
      collect() {
        try {
          const stats = probe();
          if (stats) this.set(pick(stats));
        } catch {
          // 探测失败不能把整个 /metrics 拖成 500 —— 那会在数据库出问题时
          // 顺手弄丢 RED、事件循环和 chat 延迟。保留上一次读数即可。
        }
      },
    });

  gauge(
    'circle_db_pool_max',
    'Configured maximum size of the pg connection pool (DATABASE_POOL_MAX).',
    (s) => s.max,
  );
  gauge(
    'circle_db_pool_total',
    'Connections currently established in the pg pool, idle included.',
    (s) => s.total,
  );
  gauge(
    'circle_db_pool_idle',
    'Idle connections in the pg pool.',
    (s) => s.idle,
  );
  gauge(
    'circle_db_pool_waiting',
    'Requests queued waiting for a free pg connection. Sustained >0 means the pool is the bottleneck; Postgres itself looks healthy while this happens.',
    (s) => s.waiting,
  );

  return { registry };
}
