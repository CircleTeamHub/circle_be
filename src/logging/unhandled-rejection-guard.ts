import {
  flushOperationalErrors,
  reportOperationalError,
} from './error-aggregation.service';

/**
 * 进程级兜底：未捕获的 promise rejection 上报后终止，由编排器重启干净进程。
 *
 * Node 15 起 unhandledRejection 的默认行为是 `throw` —— 一处漏掉的 .catch
 * 就足以停服。实测过一次：Redis 抖一下 + 有人断开 WebSocket，ChatGateway 里
 * 一个 `void p.then(...)` 直接把整个后端打死。那一处已单独修复，但代码库里
 * fire-and-forget 有几十处，靠人逐个记得写 .catch 不是可靠的防线。
 *
 * 预期的 Redis 等降级错误必须在调用点显式 catch；逃到这里说明代码已经违反
 * 自己的异步边界，继续服务会把未知的半完成状态暴露给后续请求。
 *
 * 只接管 unhandledRejection。uncaughtException 保持 Node 默认的快速失败 ——
 * 那种情况下进程状态未知，继续跑比崩掉更危险。
 */
let installed: (() => void) | null = null;

/** 退出前给上报链的排空预算，与 main.ts 的优雅关闭同档。 */
export const REJECTION_GUARD_FLUSH_TIMEOUT_MS = 2000;

export function installUnhandledRejectionGuard(): () => void {
  if (installed) return installed;

  const handler = (reason: unknown): void => {
    // reportOperationalError 只是入队，传输是异步的 —— 紧接着同步 exit 等于
    // 把这份报告扔掉，偏偏这是最需要它的一次（运维只会看到无故重启）。
    // 先排空再退出；排空自身有界且永不抛，绝不能挡住退出。
    void (async () => {
      try {
        reportOperationalError(reason, {
          component: 'process',
          operation: 'unhandledRejection',
          kind: 'process',
        });
        await flushOperationalErrors(REJECTION_GUARD_FLUSH_TIMEOUT_MS);
      } catch {
        // 上报链自身异常也不能阻止进程退出。
      } finally {
        process.exit(1);
      }
    })();
  };

  process.on('unhandledRejection', handler);

  const uninstall = (): void => {
    process.off('unhandledRejection', handler);
    if (installed === uninstall) installed = null;
  };
  installed = uninstall;
  return uninstall;
}
