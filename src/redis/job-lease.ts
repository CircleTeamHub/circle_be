import type { RedisService } from './redis.service';

export interface JobLeaseContext {
  /** False after renewal fails or the known lease deadline passes. */
  isCurrent(): boolean;
}

/**
 * 多实例部署时,同一个定时任务同一时刻只让一个实例跑(ScheduleModule 在每个实例上
 * 都会触发)。
 *
 * - 拿到租约:跑,跑完释放,返回 true;
 * - 别的实例持有:不跑,返回 false —— 调用方记一次 skipped(CronJobStalled 按 job
 *   取各实例的最大心跳,持有者跑成了就不会误报);
 * - Redis 没配置(单实例)或这一刻答不上来:照跑,返回 true。宁可偶尔重复做一次,
 *   也不能让协调层故障把焚毁、成员对账整个停掉 —— 所以用它的任务必须幂等。
 *
 * ttlMs 是持有者崩溃时别的实例最多要等多久;运行中每 ttlMs/3 续租。
 * 续租失败后任务应在下一批工作前检查 isCurrent 并停止。共享水位等写入需要
 * 使用传给 run 的 token 原子校验所有权；undefined 表示本轮没有共享租约。
 */
export async function runWithJobLease(
  redis: RedisService,
  job: string,
  ttlMs: number,
  run: (
    leaseToken: string | undefined,
    context: JobLeaseContext,
  ) => Promise<void>,
): Promise<boolean> {
  const key = `job-lease:${job}`;
  const acquiredAt = Date.now();
  const lease = await redis.tryAcquireLease(key, ttlMs);
  if (lease === null) return false;
  let current = true;
  let active = true;
  let expiresAt = acquiredAt + ttlMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let renewal: Promise<void> | undefined;
  const context: JobLeaseContext = {
    isCurrent: () => {
      if (lease === undefined) return true;
      if (Date.now() >= expiresAt) current = false;
      return current;
    },
  };
  const scheduleRenewal = () => {
    timer = setTimeout(
      () => {
        renewal = (async () => {
          if (!active || !context.isCurrent()) return;
          const startedAt = Date.now();
          try {
            if (await redis.renewLease(key, lease!, ttlMs)) {
              expiresAt = startedAt + ttlMs;
            } else current = false;
          } catch {
            current = false;
          }
          if (active && context.isCurrent()) scheduleRenewal();
        })();
      },
      Math.max(1, Math.floor(ttlMs / 3)),
    );
    timer.unref?.();
  };
  if (typeof lease === 'string') scheduleRenewal();
  try {
    await run(lease, context);
  } finally {
    active = false;
    if (timer) clearTimeout(timer);
    await renewal;
    if (typeof lease === 'string') await redis.releaseLease(key, lease);
  }
  return true;
}
