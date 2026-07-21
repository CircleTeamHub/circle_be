import { Gauge, Registry } from 'prom-client';

/**
 * 基建状态 gauge（#87 / #102-confirm 的告警面）。
 *
 * 两个此前「只写日志、无告警」的静默降级点，各给一个可告警的硬指标：
 * - 桶策略未确认（#87）：/readyz 有意不因它变红 —— 策略失败在每个副本上
 *   相同，fail-closed 会把整个 fleet 同时拉下线，把可观测的安全降级变成
 *   全站故障（health.endpoint.ts 的既有论证）。告警才是对的杠杆。
 * - Redis 可用性（#102）：会话撤销 fail-open 是刻意的可用性取舍，但 Redis
 *   挂掉时登出/封禁/盗号撤销全部静默失效 —— 必须有人被叫醒。
 *
 * collect() 在每次抓取时求值：状态天然新鲜，无需后台轮询任务。
 */
export interface InfraStatusDeps {
  /** UploadService.objectStoreStatus；对象存储未启用时传 null。 */
  objectStoreStatus?: (() => 'ok' | 'policy-unconfirmed' | 'disabled') | null;
  /** RedisService.ping；Redis 未配置时传 null（不注册该指标，避免误报）。 */
  redisPing?: (() => Promise<boolean>) | null;
}

export function createInfraStatusMetrics(deps: InfraStatusDeps): {
  registry: Registry;
} {
  const registry = new Registry();

  if (deps.objectStoreStatus) {
    const objectStoreStatus = deps.objectStoreStatus;
    new Gauge({
      name: 'circle_object_store_policy_unconfirmed',
      help:
        '1 when the private-media bucket policy could not be confirmed applied ' +
        '(notes/* may be anonymously readable), else 0.',
      registers: [registry],
      collect() {
        this.set(objectStoreStatus() === 'policy-unconfirmed' ? 1 : 0);
      },
    });
  }

  if (deps.redisPing) {
    const redisPing = deps.redisPing;
    new Gauge({
      name: 'circle_redis_up',
      help:
        '1 when Redis answers PING. While 0, session revocation ' +
        '(logout/ban/stolen-token) is silently fail-open.',
      registers: [registry],
      async collect() {
        let up = false;
        try {
          up = await redisPing();
        } catch {
          up = false;
        }
        this.set(up ? 1 : 0);
      },
    });
  }

  return { registry };
}
