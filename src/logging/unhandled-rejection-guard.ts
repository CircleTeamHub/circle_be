import { reportOperationalError } from './error-aggregation.service';

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

export function installUnhandledRejectionGuard(): () => void {
  if (installed) return installed;

  const handler = (reason: unknown): void => {
    // 即使上报链自身异常，也不能阻止进程退出。未知 rejection 发生后唯一
    // 可靠的恢复路径是让编排器以干净状态重启。
    try {
      reportOperationalError(reason, {
        component: 'process',
        operation: 'unhandledRejection',
        kind: 'process',
      });
    } catch {
      // 上报失败时仍执行 finally 中的退出。
    } finally {
      process.exit(1);
    }
  };

  process.on('unhandledRejection', handler);

  const uninstall = (): void => {
    process.off('unhandledRejection', handler);
    if (installed === uninstall) installed = null;
  };
  installed = uninstall;
  return uninstall;
}
