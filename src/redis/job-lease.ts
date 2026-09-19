import type { RedisService } from './redis.service';

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
 * ttlMs 是持有者崩溃时别的实例最多要等多久;任务跑得比它久时租约会先过期,
 * 可能与下一个实例短暂重叠(同样靠幂等兜住)。
 */
export async function runWithJobLease(
  redis: RedisService,
  job: string,
  ttlMs: number,
  run: () => Promise<void>,
): Promise<boolean> {
  const key = `job-lease:${job}`;
  const lease = await redis.tryAcquireLease(key, ttlMs);
  if (lease === null) return false;
  try {
    await run();
  } finally {
    if (typeof lease === 'string') await redis.releaseLease(key, lease);
  }
  return true;
}
