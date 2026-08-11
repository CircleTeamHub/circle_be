import { Counter, Gauge, Registry } from 'prom-client';

export type JobRunResult = 'success' | 'failure';

/** 一次队列深度采样。三个字段都必须给：留空会让序列消失，见 setOutboxDepth。 */
export interface OutboxDepthSample {
  queue: string;
  /** 仍会被重试的积压行数。 */
  pending: number;
  /** 最老一条待处理行的存在时长（秒）；队列为空时为 0。 */
  oldestAgeSeconds: number;
  /** 已进入死信状态、不会再被重试的行数。 */
  dead: number;
}

export interface RegisterJobOptions {
  /**
   * 该任务的预期执行周期（秒）。导出成 `circle_cron_interval_seconds{job}`，
   * 让心跳告警能写成 `滞后 > 3 × 周期` —— 每分钟任务和每天任务因此可以共用
   * 一条规则，不必为每个任务手写阈值（手写必然漏配新任务）。
   */
  intervalSeconds?: number;
  /** 播种心跳的时刻，默认现在。 */
  nowMs?: number;
}

export interface JobMetrics {
  readonly registry: Registry;
  /**
   * 声明一个已知任务，并把心跳播种到 `nowMs`（默认现在）。重复调用只播种一次。
   */
  registerJob(job: string, options?: RegisterJobOptions): void;
  recordRun(
    job: string,
    result: JobRunResult,
    durationSeconds: number,
    nowMs?: number,
  ): void;
  setOutboxDepth(sample: OutboxDepthSample): void;
}

/** 任务名超预算后的归并桶 —— 约束 `job` / `queue` 的标签基数。 */
export const OTHER_JOB = 'other';

/**
 * 任务名上限。调用方传的都是代码里的字符串字面量，这个额度非常宽裕；它只在
 * 将来有人误传高基数值（比如用户 ID）时才起作用，否则那会撑爆序列数。
 * 与 business-metrics 的 MAX_EVENT_NAMES 同一套防御。
 */
const MAX_JOB_NAMES = 100;

/**
 * 定时任务与 outbox 队列的可观测面。
 *
 * 这里补的是此前**完全没有信号**的一类故障：4 个 outbox 处理器都自己 catch 掉
 * 异常、把错误写进行上的 `lastError` 然后继续，异常永远不会逃出去 —— Sentry
 * 收不到事件（captureError 只在 ErrorLoggingInterceptor 里被调用，即只覆盖 HTTP
 * 5xx），Prometheus 也没有任何指标反映它。队列堵死时大盘上一切正常。
 * notification-push-outbox 甚至专门设计了 TERMINAL 死信状态「让积压对运维可见」，
 * 但在此之前没有任何东西在看它。
 *
 * 三类指标各自对应一种失效：
 * - `circle_cron_runs_total{job,result}`：任务在跑但一直报错。
 * - `circle_cron_last_success_timestamp_seconds{job}`：任务**根本没在跑**
 *   （进程存活但调度器死了 / 任务被异常卡住）—— 这类「什么都没发生」的故障
 *   是错误告警和 RED 指标都覆盖不到的。
 * - `circle_outbox_*{queue}`：任务在跑也不报错，但活干不完（积压增长）或
 *   已经放弃（死信堆积）。
 */
export function createJobMetrics(): JobMetrics {
  const registry = new Registry();

  const runsTotal = new Counter({
    name: 'circle_cron_runs_total',
    help: 'Scheduled job runs, by job name and result.',
    labelNames: ['job', 'result'],
    registers: [registry],
  });

  const lastSuccess = new Gauge({
    name: 'circle_cron_last_success_timestamp_seconds',
    help: 'Unix timestamp of the last successful run of a scheduled job.',
    labelNames: ['job'],
    registers: [registry],
  });

  const lastDuration = new Gauge({
    name: 'circle_cron_last_duration_seconds',
    help: 'Wall-clock duration of the last run of a scheduled job.',
    labelNames: ['job'],
    registers: [registry],
  });

  const intervalSeconds = new Gauge({
    name: 'circle_cron_interval_seconds',
    help: 'Expected seconds between runs of a scheduled job.',
    labelNames: ['job'],
    registers: [registry],
  });

  const outboxPending = new Gauge({
    name: 'circle_outbox_pending',
    help: 'Rows still awaiting processing in an outbox queue.',
    labelNames: ['queue'],
    registers: [registry],
  });

  const outboxOldestAge = new Gauge({
    name: 'circle_outbox_oldest_age_seconds',
    help: 'Age of the oldest unprocessed row in an outbox queue, 0 when empty.',
    labelNames: ['queue'],
    registers: [registry],
  });

  const outboxDead = new Gauge({
    name: 'circle_outbox_dead',
    help: 'Rows in a terminal/dead-letter state that will never be retried.',
    labelNames: ['queue'],
    registers: [registry],
  });

  const seenNames = new Set<string>();
  const clampName = (name: string): string => {
    if (seenNames.has(name)) return name;
    if (seenNames.size >= MAX_JOB_NAMES) return OTHER_JOB;
    seenNames.add(name);
    return name;
  };

  // 归并桶自己也要能被命名，否则第 101 个任务会把 'other' 也算进预算。
  seenNames.add(OTHER_JOB);

  // 心跳的权威副本留在闭包里，不去反射 prom-client 的内部结构。
  const heartbeatSeconds = new Map<string, number>();

  const advanceHeartbeat = (job: string, seconds: number): void => {
    // 只进不退：并发/重叠执行时，一次早开始晚结束的运行不能把心跳拨回去，
    // 否则 `time() - metric` 会凭空冒出一个假的滞后尖峰。
    const current = heartbeatSeconds.get(job);
    if (current !== undefined && seconds <= current) return;
    heartbeatSeconds.set(job, seconds);
    lastSuccess.set({ job }, seconds);
  };

  return {
    registry,

    registerJob(job, options = {}) {
      const name = clampName(job);
      if (options.intervalSeconds !== undefined) {
        intervalSeconds.set({ job: name }, options.intervalSeconds);
      }
      if (heartbeatSeconds.has(name)) return;
      // 播种的是心跳，不是「跑过一次」—— 刻意不碰 runsTotal，否则大盘上
      // 一个从没执行过的任务会显示成功率 100%。
      advanceHeartbeat(name, (options.nowMs ?? Date.now()) / 1000);
    },

    recordRun(job, result, durationSeconds, nowMs = Date.now()) {
      const name = clampName(job);
      runsTotal.inc({ job: name, result });
      lastDuration.set({ job: name }, durationSeconds);
      if (result !== 'success') return;
      advanceHeartbeat(name, nowMs / 1000);
    },

    setOutboxDepth({ queue, pending, oldestAgeSeconds, dead }) {
      const name = clampName(queue);
      // 三个都显式写：队列排空时留着上一次的非零值会让告警永远 firing，
      // 而干脆不写这个 label 又会让序列消失、`> 阈值` 打不中。
      outboxPending.set({ queue: name }, pending);
      outboxOldestAge.set({ queue: name }, oldestAgeSeconds);
      outboxDead.set({ queue: name }, dead);
    },
  };
}

/** 全进程单例，经 `/metrics` 暴露（在 setup.ts 里并入合并注册表）。 */
export const jobMetrics = createJobMetrics();
