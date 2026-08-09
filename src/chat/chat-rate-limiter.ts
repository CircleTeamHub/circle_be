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
  /** 上次全量清扫的时刻;惰性触发,不用定时器。 */
  private lastSweepAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * 惰性全量回收。
   *
   * pruneExpired 只在「断开的那一刻」看一眼那一个 key,而典型的一次性用户是
   * 发一条消息就断开:那时记录还在窗口内,key 被保留,此后再没有任何东西会回来
   * 看它 —— 除非同一个人重连。长跑实例于是按「历史上出现过的用户数」单调增长,
   * 四个限流器各存一份,和「有界内存」的初衷正好相反。
   *
   * 所以补一次不依赖任何人重连的清扫:每过一个窗口期(至少 60s)扫一遍,丢掉
   * 窗口内已无记录的 key。活跃窗口内的 key 一律保留 —— 那正是「断开重连不重置
   * 配额」赖以成立的东西,清扫不能把它顺手清掉。
   *
   * 用惰性而不是 setInterval:没有需要在关停时清理的句柄,测试里也能靠注入的
   * now 精确驱动,不必依赖假计时器。
   */
  private sweepIfDue(now: number): void {
    const interval = Math.max(this.windowMs, 60_000);
    if (now - this.lastSweepAt < interval) return;
    this.lastSweepAt = now;
    const cutoff = now - this.windowMs;
    for (const [key, timestamps] of this.hits) {
      if (timestamps.every((t) => t <= cutoff)) this.hits.delete(key);
    }
  }

  /** 当前保有的 key 数(仅供测试与可观测性断言)。 */
  size(): number {
    return this.hits.size;
  }

  /** 尝试计数一次;窗口内已达上限返回 false(不计入)。 */
  tryAcquire(key: string, now: number = Date.now()): boolean {
    this.sweepIfDue(now);
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

/**
 * G-04 跨实例限流:Redis ZSET 滑动窗口(Lua 原子)为主,Redis 不可用时
 * 回退到上面的每实例本地限流 —— 限流放宽 N 倍但仍有界,好过整条链路
 * 因 Redis 故障拒绝服务。
 */
import type { RedisService } from 'src/redis/redis.service';

export class DistributedRateLimiter {
  private readonly local: SlidingWindowRateLimiter;

  constructor(
    private readonly name: string,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly redis: RedisService,
  ) {
    this.local = new SlidingWindowRateLimiter(limit, windowMs);
  }

  async tryAcquire(key: string): Promise<boolean> {
    const verdict = await this.redis.slidingWindowAcquire(
      `chat:rl:${this.name}:${key}`,
      this.limit,
      this.windowMs,
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    if (verdict === null) return this.local.tryAcquire(key);
    return verdict;
  }

  /** 本地回退态的清理;Redis 侧靠 PEXPIRE 自清。 */
  pruneExpired(key: string): void {
    this.local.pruneExpired(key);
  }
}
