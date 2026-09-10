/**
 * 进程级兜底：一处漏掉的 .catch 不该把整个后端打死。
 *
 * 2026-09-08 实测：Redis 抖一下 + 有人断开 WebSocket，ChatGateway 里一个
 * `void p.then(...)`（少了 .catch）就让 Node 以未捕获 rejection 终止进程。
 * 那一处已经单独修了，但代码库里 fire-and-forget 有几十处，靠人逐个记得
 * 加 .catch 不是可靠的防线。
 *
 * 兜底只做「上报 + 继续跑」，不做静默吞：rejection 会进错误聚合/Sentry，
 * 漏网的 .catch 照样看得见，只是不再以停服为代价。
 *
 * 注意边界：这里只接管 unhandledRejection。uncaughtException 保持 Node 默认的
 * 快速失败 —— 那种情况下进程状态未知，继续跑比崩掉更危险。
 */
import { installUnhandledRejectionGuard } from './unhandled-rejection-guard';
import { reportOperationalError } from './error-aggregation.service';

jest.mock('./error-aggregation.service', () => ({
  reportOperationalError: jest.fn(),
}));

const reportMock = reportOperationalError as jest.MockedFunction<
  typeof reportOperationalError
>;

describe('installUnhandledRejectionGuard', () => {
  let uninstall: (() => void) | undefined;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    exitSpy.mockRestore();
  });

  function emitRejection(reason: unknown) {
    // 直接触发事件，不真的制造一个未处理的 promise —— 后者会污染整个 jest 进程。
    (process as NodeJS.EventEmitter).emit(
      'unhandledRejection',
      reason,
      Promise.resolve(),
    );
  }

  it('reports an unhandled rejection and terminates for a clean restart', () => {
    const before = process.listenerCount('unhandledRejection');
    uninstall = installUnhandledRejectionGuard();
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    const reason = new Error('Connection is closed.');
    expect(() => emitRejection(reason)).not.toThrow();

    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock.mock.calls[0][0]).toBe(reason);
    expect(reportMock.mock.calls[0][1]).toEqual({
      component: 'process',
      operation: 'unhandledRejection',
      kind: 'process',
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('重复安装不会叠加监听器（模块可能被多次引导）', () => {
    const before = process.listenerCount('unhandledRejection');
    uninstall = installUnhandledRejectionGuard();
    const second = installUnhandledRejectionGuard();

    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    emitRejection(new Error('boom'));
    expect(reportMock).toHaveBeenCalledTimes(1);

    second();
  });

  it('卸载后不再接管，恢复 Node 默认行为', () => {
    const before = process.listenerCount('unhandledRejection');
    const stop = installUnhandledRejectionGuard();
    stop();

    expect(process.listenerCount('unhandledRejection')).toBe(before);
    emitRejection(new Error('after uninstall'));
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('terminates even when operational-error reporting itself throws', () => {
    reportMock.mockImplementation(() => {
      throw new Error('reporter exploded');
    });
    uninstall = installUnhandledRejectionGuard();

    expect(() => emitRejection(new Error('boom'))).not.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
