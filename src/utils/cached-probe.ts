/**
 * 给外部依赖的连通性检查加上缓存、并发合并和超时。
 *
 * /readyz 和 /metrics 的抓取都会调用它：不缓存的话，每一次容器健康检查、每一次
 * Prometheus 抓取都要打一遍对方；不设超时的话，对方卡住会把探针一起拖住。
 *
 * - ttlMs 内复用上一次的结果（成功、失败都缓存，失败时不会被高频探测放大）；
 * - 同一时刻只有一个检查在飞，并发调用共用它；
 * - 超过 timeoutMs 判为不可达，并通过 AbortSignal 中止那次请求；
 * - 检查抛错也判为不可达，绝不向调用方抛。
 */
export interface CachedProbeOptions {
  ttlMs: number;
  timeoutMs: number;
  /** 毫秒时钟，只为测试注入。 */
  now?: () => number;
}

export function createCachedProbe(
  check: (signal: AbortSignal) => Promise<boolean>,
  { ttlMs, timeoutMs, now = Date.now }: CachedProbeOptions,
): () => Promise<boolean> {
  let cached: { at: number; value: boolean } | null = null;
  let inFlight: Promise<boolean> | null = null;

  const run = async (): Promise<boolean> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(false);
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([
        check(controller.signal).then(
          (value) => value,
          () => false,
        ),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  return () => {
    if (cached && now() - cached.at < ttlMs) {
      return Promise.resolve(cached.value);
    }
    if (!inFlight) {
      inFlight = run().then((value) => {
        cached = { at: now(), value };
        inFlight = null;
        return value;
      });
    }
    return inFlight;
  };
}
