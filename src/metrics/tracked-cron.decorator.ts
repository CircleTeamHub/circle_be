import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import { Cron, CronExpression, CronOptions } from '@nestjs/schedule';
import { jobMetrics, type JobMetrics } from './job-metrics';

/**
 * 各 cron 表达式的预期周期（秒），导出成 `circle_cron_interval_seconds`。
 * 心跳告警据此写成 `滞后 > 3 × 周期`：每分钟任务和每天 4 点的任务共用一条
 * 规则，不必逐个手写阈值 —— 手写阈值的结果必然是新任务漏配、悄无声息。
 *
 * 新增表达式必须同时加进这里，`tracked-cron.coverage.spec.ts` 会扫描所有
 * @TrackedCron 调用点把漏配钉住。
 */
const INTERVAL_SECONDS: ReadonlyMap<string, number> = new Map([
  [CronExpression.EVERY_MINUTE, 60],
  [CronExpression.EVERY_5_MINUTES, 5 * 60],
  [CronExpression.EVERY_30_MINUTES, 30 * 60],
  [CronExpression.EVERY_HOUR, 60 * 60],
  [CronExpression.EVERY_DAY_AT_4AM, 24 * 60 * 60],
  [CronExpression.EVERY_DAY_AT_5AM, 24 * 60 * 60],
]);

/** 未登记表达式的兜底周期。宁可迟报也不要因为没有序列而完全不报。 */
const FALLBACK_INTERVAL_SECONDS = 24 * 60 * 60;

const logger = new Logger('TrackedCron');

export function intervalSecondsFor(expression: string): number {
  const known = INTERVAL_SECONDS.get(expression);
  if (known !== undefined) return known;
  logger.warn(
    `No interval mapping for cron expression "${expression}"; falling back to ` +
      `${FALLBACK_INTERVAL_SECONDS}s. Add it to INTERVAL_SECONDS so the ` +
      `CronJobStalled alert uses the right threshold.`,
  );
  return FALLBACK_INTERVAL_SECONDS;
}

export const KNOWN_CRON_EXPRESSIONS: readonly string[] = [
  ...INTERVAL_SECONDS.keys(),
];

export interface JobClock {
  /**
   * 单调毫秒，只用来测耗时。刻意不用 Date.now()：NTP 校时/夏令时跳变会让
   * 墙钟倒退，算出负耗时。
   */
  elapsedMs(): number;
  /** 墙钟毫秒，只用来盖心跳时间戳（要和 PromQL 的 time() 对齐）。 */
  nowMs(): number;
}

const systemClock: JobClock = {
  elapsedMs: () => performance.now(),
  nowMs: () => Date.now(),
};

interface TrackedJobContext {
  failed: boolean;
}

/**
 * 当前正在执行的任务。用 AsyncLocalStorage 而不是给每个方法加参数：调用点
 * 只写 reportHandledJobFailure()，不必重复一遍任务名（重复就会漂移）。
 */
const currentJob = new AsyncLocalStorage<TrackedJobContext>();

/**
 * 在 catch 里标记「这一轮实际失败了」，供**吞掉异常后正常返回**的任务使用。
 *
 * 大多数定时任务把整轮工作包在 try/catch 里并在失败后正常返回
 * （chat-circle-sync 扫描失败即 return，各 cleanup 记完日志继续）。包装器只
 * 看「有没有抛」的话，持续故障期间它们每轮都算成功、心跳照常前进 ——
 * CronJobFailing 与 CronJobStalled 双双打不中，而实际上一点活都没干。
 *
 * 脱离 cron 上下文调用（单测、管理台手动触发）是无操作，绝不抛。
 */
export function reportHandledJobFailure(): void {
  const context = currentJob.getStore();
  if (context) context.failed = true;
}

/**
 * 执行一次任务并记账：成功/失败计数、耗时、成功心跳。**不吞异常** —— 原样
 * 重抛，让 @sentry/node 的进程级集成照旧收到未处理 rejection。
 *
 * 「正常返回但调用过 reportHandledJobFailure()」与「抛异常」记为同一种结果。
 *
 * 墙钟只在任务返回之后读。包装器若在调用原函数**之前**读 Date.now()，就会
 * 打乱被包装方法自己的时钟序列 —— notification-retention 的扫表预算用
 * `Date.now() - startedAt` 判断，其单测用 `mockReturnValueOnce(0)` 钉住第一次
 * 读数，多插一次读取会让预算永远判不到、扫表死循环。计耗时用单调时钟就同时
 * 解决了这个耦合和倒退问题。
 */
export async function runTracked<T>(
  metrics: JobMetrics,
  job: string,
  run: () => Promise<T> | T,
  clock: JobClock = systemClock,
): Promise<T> {
  const startedAt = clock.elapsedMs();
  const context: TrackedJobContext = { failed: false };
  try {
    const result = await currentJob.run(context, () => run());
    // 「正常返回但调用过 reportHandledJobFailure()」与「抛异常」记为同一种
    // 结果：心跳不前进，failure 计数递增。
    if (context.failed) {
      metrics.recordRun(job, 'failure', (clock.elapsedMs() - startedAt) / 1000);
      return result;
    }
    metrics.recordRun(
      job,
      'success',
      (clock.elapsedMs() - startedAt) / 1000,
      clock.nowMs(),
    );
    return result;
  } catch (error) {
    metrics.recordRun(job, 'failure', (clock.elapsedMs() - startedAt) / 1000);
    throw error;
  }
}

/**
 * `@Cron` + 运行记账。用它替换裸 `@Cron`，任务就同时获得：
 * - `circle_cron_runs_total{job,result}`：在跑但一直失败
 * - `circle_cron_last_success_timestamp_seconds{job}`：**根本没在跑**
 *
 * 后者是关键：进程活着、HTTP 正常、Sentry 一片安静，而调度器已经停了 ——
 * 这类故障错误监控和 RED 指标都看不见，只有心跳能发现。
 *
 * 心跳在**装饰期**（模块加载时）就播种成进程启动时刻，而不是等第一次成功。
 * 否则首次成功之前序列根本不存在，`time() - metric > 阈值` 求值为空，一个
 * 从开机起就没跑过的任务反而永远不告警 —— 与 alerts.yml 里 `up` 序列消失
 * 导致 `up == 0` 打不中、需要 `absent()` 兜底是同一个坑。
 */
export function TrackedCron(
  expression: string,
  job: string,
  options?: CronOptions,
): MethodDecorator {
  jobMetrics.registerJob(job, {
    intervalSeconds: intervalSecondsFor(expression),
  });

  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: PropertyDescriptor,
  ) => {
    const original = descriptor.value as (...args: unknown[]) => unknown;
    descriptor.value = function trackedCronRun(
      this: unknown,
      ...args: unknown[]
    ) {
      return runTracked(jobMetrics, job, () => original.apply(this, args));
    };
    // 先换掉 descriptor.value 再交给 Cron：调度器元数据必须落在包装函数上，
    // 否则 explorer 注册的是未记账的原函数。
    return Cron(expression, options)(target, propertyKey, descriptor);
  };
}
