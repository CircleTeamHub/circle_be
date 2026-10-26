/**
 * 限制同一时刻在飞的异步任务数(超出的按提交顺序排队)。
 *
 * 用在「一次请求扇出十几二十条只读查询」的地方:连接池默认只有 10 个,整批
 * Promise.all 同时打出去会把池占满,把真实请求排到 10 秒取连接超时上 ——
 * src/metrics/outbox-depth.service.ts 的 OUTBOX_PROBE_MAX_CONCURRENT_QUERIES
 * 注释讲过同一件事。
 *
 * 任务以 thunk 传入,轮到它才调用:PrismaPromise 是惰性的,被 then 时才真正发查询,
 * 所以 `limit(() => prisma.user.count())` 在排队期间不会占连接。
 */
export type ConcurrencyLimiter = <T>(task: () => PromiseLike<T>) => Promise<T>;

/** 管理台读接口扇出时的并发上限:最多占池里 3 个连接,其余留给业务请求。 */
export const ADMIN_FANOUT_MAX_CONCURRENT_QUERIES = 3;

/** 不限并发的默认实现(直接调用),供不需要限流的调用方和单测使用。 */
export const runUnlimited: ConcurrencyLimiter = (task) =>
  Promise.resolve().then(task);

export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  if (!Number.isInteger(max) || max < 1) {
    throw new Error(`Concurrency limit must be a positive integer: ${max}`);
  }
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    const next = queue.shift();
    if (next) next();
    else active--;
  };

  return <T>(task: () => PromiseLike<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        // 同步抛错也走 reject,并且照样释放名额。
        Promise.resolve().then(task).then(resolve, reject).finally(release);
      };
      if (active < max) {
        active++;
        start();
      } else {
        // 名额由完成的任务直接转交给排队者,active 不变。
        queue.push(start);
      }
    });
}
