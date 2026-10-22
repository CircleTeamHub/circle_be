import { Logger } from '@nestjs/common';
import { processMetrics } from '../metrics/process-metrics';
import {
  flushErrorAggregation,
  reportOperationalError,
} from './error-aggregation.service';
import { sanitizeLogValue } from './log-sanitizer';

/**
 * 进程级兜底：未捕获的 promise rejection 上报后继续跑，不再终止进程。
 *
 * Node 15 起 unhandledRejection 的默认行为是 `throw` —— 一处漏掉的 .catch
 * 就足以停服。实测过一次：Redis 抖一下 + 有人断开 WebSocket，ChatGateway 里
 * 一个 `void p.then(...)` 直接把整个后端打死。那一处已单独修复，但代码库里
 * fire-and-forget 有几十处，靠人逐个记得写 .catch 不是可靠的防线。
 *
 * 这不是把错误藏起来：rejection 照常进错误聚合 / Sentry，漏网的 .catch 一样
 * 看得见，只是不再以停服为代价。错误聚合默认关闭，那时上报是 no-op，所以
 * 每条 rejection 还会计数（circle_unhandled_rejections_total）并写一行脱敏
 * 日志 —— 这两样不依赖 Sentry，是生产上保底的信号。
 *
 * rejection 上报后继续运行；uncaughtException 则由同一所有者上报、限时刷新并
 * 非零退出。禁用 SDK 自带的两个进程监听器可避免重复事件和原始错误写入 stderr。
 */
let installed: (() => void) | null = null;

interface GuardSinks {
  logError(message: string): void;
  exit(code: number): void;
  logRejection(message: string): void;
  countRejection(): void;
}

// app.useLogger() 之后 Nest 的 Logger 实例会转给 winston（JSON 文件 → Loki）；
// 在那之前的启动早期，落到 Nest 默认的控制台输出。
const rejectionLogger = new Logger('UnhandledRejection');

const processSinks: GuardSinks = {
  logError: (message) => console.error(message),
  exit: (code) => process.exit(code),
  logRejection: (message) => rejectionLogger.error(message),
  countRejection: () => processMetrics.recordUnhandledRejection(),
};

// 计数器每条都加，日志按位置限流：Redis 抖动时一处 fire-and-forget 可能每秒
// 漏几千条，逐条写会把磁盘写满（winston 轮转没有总量上限）。位置种类也有上限：
// 表满时先腾出窗口外的旧位置，仍然满才并进同一个溢出桶，内存不随错误种类增长。
const REJECTION_LOG_WINDOW_MS = 60_000;
const MAX_REJECTION_LOG_SIGNATURES = 100;
const OVERFLOW_SIGNATURE = 'source=other (signature limit reached)';
// Prisma / ioredis 的 rejection 第一帧在 node_modules 里，漏 .catch 的业务调用
// 点在后面几帧；只取第一帧的话所有调用点共用一个签名，也定位不到是哪一处。
const DIAGNOSTIC_STACK_FRAMES = 4;

function createRejectionLogLimiter(
  log: (message: string) => void,
): (diagnostic: string) => void {
  const lastLogged = new Map<string, { at: number; suppressed: number }>();
  const evictExpired = (now: number): void => {
    for (const [signature, entry] of lastLogged) {
      if (now - entry.at >= REJECTION_LOG_WINDOW_MS)
        lastLogged.delete(signature);
    }
  };
  return (diagnostic) => {
    const now = Date.now();
    if (
      !lastLogged.has(diagnostic) &&
      lastLogged.size >= MAX_REJECTION_LOG_SIGNATURES
    )
      evictExpired(now);
    const signature =
      lastLogged.has(diagnostic) ||
      lastLogged.size < MAX_REJECTION_LOG_SIGNATURES
        ? diagnostic
        : OVERFLOW_SIGNATURE;
    const previous = lastLogged.get(signature);
    if (previous && now - previous.at < REJECTION_LOG_WINDOW_MS) {
      lastLogged.set(signature, {
        ...previous,
        suppressed: previous.suppressed + 1,
      });
      return;
    }
    lastLogged.set(signature, { at: now, suppressed: 0 });
    log(
      `[unhandledRejection] ${signature}; suppressedSinceLast=${previous?.suppressed ?? 0}; continuing.`,
    );
  };
}

function safeDiagnostic(error: unknown): string {
  const sanitized = sanitizeLogValue(error);
  if (!sanitized || typeof sanitized !== 'object') return 'errorName=Unknown';

  const value = sanitized as { name?: unknown; stack?: unknown };
  const errorName = typeof value.name === 'string' ? value.name : 'Unknown';
  // sanitizeLogValue 已把每帧收成 `at 文件名:行:列`，不含路径和正文。
  const source =
    typeof value.stack === 'string'
      ? value.stack
          .split('\n')
          .filter((line) => line.startsWith('at '))
          .slice(0, DIAGNOSTIC_STACK_FRAMES)
          .join(' <- ')
      : undefined;
  return source
    ? `errorName=${errorName} source=${source}`
    : `errorName=${errorName}`;
}

export function installUnhandledRejectionGuard(
  overrides: Partial<GuardSinks> = {},
): () => void {
  if (installed) return installed;

  const sinks: GuardSinks = { ...processSinks, ...overrides };
  const logRejection = createRejectionLogLimiter(sinks.logRejection);

  const handler = (reason: unknown): void => {
    // 三件事各自兜一层：任何一件抛错都不能挡住另外两件，兜底本身也绝不能
    // 成为新的崩溃源（它跑在事件循环里，抛出去就没人接了）。
    try {
      sinks.countRejection();
    } catch {
      // 计数失败不影响日志和上报。
    }
    try {
      logRejection(safeDiagnostic(reason));
    } catch {
      // 日志失败不影响上报。
    }
    try {
      reportOperationalError(reason, {
        component: 'process',
        operation: 'unhandledRejection',
        kind: 'process',
      });
    } catch {
      // 上报都失败了就只能放弃这一条 —— 但进程要活着。
    }
  };

  process.on('unhandledRejection', handler);
  const fatalHandler = (error: unknown): void => {
    try {
      reportOperationalError(error, {
        component: 'process',
        operation: 'uncaughtException',
        kind: 'process',
      });
    } catch {
      // Reporting must not prevent the fatal flush/exit path.
    } finally {
      try {
        sinks.logError(
          `[fatal] Uncaught exception; ${safeDiagnostic(error)}; exiting.`,
        );
      } catch {
        // The process must still terminate if stderr is unavailable.
      }
      void flushErrorAggregation(2000)
        .catch(() => false)
        .finally(() => sinks.exit(1));
    }
  };
  process.on('uncaughtException', fatalHandler);

  const uninstall = (): void => {
    process.off('unhandledRejection', handler);
    process.off('uncaughtException', fatalHandler);
    if (installed === uninstall) installed = null;
  };
  installed = uninstall;
  return uninstall;
}
