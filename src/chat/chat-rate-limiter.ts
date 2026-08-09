// 事件级滑动窗口限流器(纯内存,单实例语义)。
// squady 网关缺这一层,是移植时补上的安全项;多实例部署时各实例独立限流,
// 上限放大 N 倍但仍有界,可接受。
//
// key 用**认证用户 id** 而不是 socket.id:按 socket 计数的话,断开重连就是
// 一个全新的 key,配额立刻归零 —— 客户端只要每发满 20 条就重连一次,限流
// 等于不存在。代价是断开时不能直接 clear(那等价于同一个绕过),改用
// pruneExpired():窗口内还有记录就留着,全过期了才回收。

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

  /**
   * 断开连接时回收该 key —— 但只在窗口内已无记录时回收。
   *
   * 直接 delete 会让「发满即重连」重新变成免费的配额重置(这正是改用
   * userId 作 key 要堵的那个洞);留着不回收又会随用户数无限增长。
   * 折中:窗口过完自然回收,活跃窗口一律保留。
   */
  pruneExpired(key: string, now: number = Date.now()): void {
    const cutoff = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length === 0) {
      this.hits.delete(key);
      return;
    }
    this.hits.set(key, recent);
  }
}
