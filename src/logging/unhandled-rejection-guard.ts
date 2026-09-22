import {
  flushErrorAggregation,
  reportOperationalError,
} from './error-aggregation.service';

/**
 * 进程级兜底：未捕获的 promise rejection 上报后继续跑，不再终止进程。
 *
 * Node 15 起 unhandledRejection 的默认行为是 `throw` —— 一处漏掉的 .catch
 * 就足以停服。实测过一次：Redis 抖一下 + 有人断开 WebSocket，ChatGateway 里
 * 一个 `void p.then(...)` 直接把整个后端打死。那一处已单独修复，但代码库里
 * fire-and-forget 有几十处，靠人逐个记得写 .catch 不是可靠的防线。
 *
 * 这不是把错误藏起来：rejection 照常进错误聚合 / Sentry，漏网的 .catch 一样
 * 看得见，只是不再以停服为代价。
 *
 * rejection 上报后继续运行；uncaughtException 则由同一所有者上报、限时刷新并
 * 非零退出。禁用 SDK 自带的两个进程监听器可避免重复事件和原始错误写入 stderr。
 */
let installed: (() => void) | null = null;

interface FatalSinks {
  logError(message: string): void;
  exit(code: number): void;
}

const processFatalSinks: FatalSinks = {
  logError: (message) => console.error(message),
  exit: (code) => process.exit(code),
};

export function installUnhandledRejectionGuard(
  sinks: FatalSinks = processFatalSinks,
): () => void {
  if (installed) return installed;

  const handler = (reason: unknown): void => {
    // reportOperationalError 内部已有 try/catch，这里再兜一层：兜底本身
    // 绝不能成为新的崩溃源（它跑在事件循环里，抛出去就没人接了）。
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
        sinks.logError('[fatal] Uncaught exception; exiting.');
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
