// 每 socket 的事件级滑动窗口限流器(纯内存,单实例语义)。
// squady 网关缺这一层,是移植时补上的安全项;多实例部署时各实例独立限流,
// 上限放大 N 倍但仍有界,可接受。

export class SlidingWindowRateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** 尝试计数一次;窗口内已达上限返回 false(不计入)。 */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.limit) {
      // 写回裁剪后的数组,防止被拒请求让旧时间戳无限堆积。
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** 断开连接时清掉该 key,避免长期运行的内存泄漏。 */
  clear(key: string): void {
    this.hits.delete(key);
  }
}
