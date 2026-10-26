/**
 * 进程内 TTL 缓存,给「每次 App 启动都拉、所有人结果相同」的小接口用。
 *
 * - ttlMs 内命中直接返回;过期后下一次调用重新加载;
 * - 同一个 key 的并发未命中合并成一次加载;
 * - 失败不缓存;
 * - clear() 由同进程的写路径在提交后调用:清掉所有条目,并且让 clear 之前已经在飞
 *   的加载既不写回缓存、也不再被新请求复用(它可能读到的是写前的数据);
 * - maxEntries 限制条目数,超出时先丢过期的、再丢最早写入的 —— 匿名接口的入参可以
 *   被随意枚举,缓存不能因此无限长大。
 *
 * 多实例部署时别的实例的写入要等 TTL 过期才可见,调用方按这个口径选 TTL。
 */
export interface TtlCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** 毫秒时钟,只为测试注入。 */
  now?: () => number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  private readonly loading = new Map<string, Promise<V>>();
  private generation = 0;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor({ ttlMs, maxEntries, now = () => Date.now() }: TtlCacheOptions) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.now = now;
  }

  get size(): number {
    return this.entries.size;
  }

  getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit) {
      if (hit.expiresAt > this.now()) return Promise.resolve(hit.value);
      this.entries.delete(key);
    }
    const running = this.loading.get(key);
    if (running) return running;

    const generation = this.generation;
    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (generation === this.generation) this.store(key, value);
        return value;
      })
      .finally(() => {
        if (this.loading.get(key) === promise) this.loading.delete(key);
      });
    this.loading.set(key, promise);
    return promise;
  }

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.loading.clear();
  }

  private store(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.entries.size <= this.maxEntries) return;
    const now = this.now();
    for (const [entryKey, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(entryKey);
    }
    // Map 按插入顺序迭代:最先写入的就是最老的。
    for (const entryKey of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(entryKey);
    }
  }
}
