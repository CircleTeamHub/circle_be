import { Counter, Registry } from 'prom-client';

export interface ProcessMetrics {
  readonly registry: Registry;
  recordUnhandledRejection(): void;
}

/**
 * 进程级兜底的计数。错误聚合默认关闭，那时 unhandled-rejection-guard 的上报
 * 是 no-op —— 这个计数器加上同一处写的那行日志，是漏网 rejection 在生产上
 * 唯一保底的信号（UnhandledRejectionsOccurring 告警读的就是它）。
 *
 * 不带标签：错误类型和位置来自运行时数据，做标签会让基数无界；要看具体是哪
 * 一处，去日志里按时间对 `[unhandledRejection]` 那一行。
 */
export function createProcessMetrics(): ProcessMetrics {
  const registry = new Registry();
  const unhandledRejections = new Counter({
    name: 'circle_unhandled_rejections_total',
    help: 'Promise rejections that reached the process-level guard (a missing .catch).',
    registers: [registry],
  });

  return {
    registry,
    recordUnhandledRejection() {
      unhandledRejections.inc();
    },
  };
}

export const processMetrics = createProcessMetrics();
