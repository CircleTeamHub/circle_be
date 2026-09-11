/**
 * 进程级兜底：一处漏掉的 .catch 不该把整个后端打死。
 *
 * 2026-09-08 实测：Redis 抖一下 + 有人断开 WebSocket，ChatGateway 里一个
 * `void p.then(...)`（少了 .catch）就让 Node 以未捕获 rejection 终止进程。
 * 那一处已经单独修了，但代码库里 fire-and-forget 有几十处，靠人逐个记得
 * 加 .catch 不是可靠的防线。
 *
 * 兜底同样以退出收场（未知的半完成状态不该继续服务），但不做静默吞：退出
 * **之前**先把错误聚合排空出去，否则 reportOperationalError 只是入队、紧接着
 * 的 process.exit 会把那份报告扔掉 —— 运维只看到一次无故重启。
 *
 * 注意边界：这里只接管 unhandledRejection。uncaughtException 保持 Node 默认的
 * 快速失败 —— 那种情况下进程状态未知，继续跑比崩掉更危险。
 */
import {
  installUnhandledRejectionGuard,
  REJECTION_GUARD_FLUSH_TIMEOUT_MS,
} from './unhandled-rejection-guard';
import {
  flushOperationalErrors,
  reportOperationalError,
} from './error-aggregation.service';

jest.mock('./error-aggregation.service', () => ({
  reportOperationalError: jest.fn(),
  flushOperationalErrors: jest.fn(() => Promise.resolve(true)),
}));

const reportMock = reportOperationalError as jest.MockedFunction<
  typeof reportOperationalError
>;
const flushMock = flushOperationalErrors as jest.MockedFunction<
  typeof flushOperationalErrors
>;

describe('installUnhandledRejectionGuard', () => {
  let uninstall: (() => void) | undefined;
  let exitSpy: jest.SpiedFunction<typeof process.exit>;

  beforeEach(() => {
    jest.clearAllMocks();
    flushMock.mockResolvedValue(true);
    exitSpy = jest
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
    exitSpy.mockRestore();
  });

  /**
   * 直接触发事件，不真的制造一个未处理的 promise —— 后者会污染整个 jest 进程。
   * handler 现在是异步的（退出前要排空上报链），所以返回一个「跑完微任务队列」
   * 的 promise，断言必须 await 它。
   */
  async function emitRejection(reason: unknown): Promise<void> {
    (process as NodeJS.EventEmitter).emit(
      'unhandledRejection',
      reason,
      Promise.resolve(),
    );
    // report → await flush → finally exit：两个 await 边界，多跑几轮兜住。
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  }

  it('reports an unhandled rejection and terminates for a clean restart', async () => {
    const before = process.listenerCount('unhandledRejection');
    uninstall = installUnhandledRejectionGuard();
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    const reason = new Error('Connection is closed.');
    await expect(emitRejection(reason)).resolves.toBeUndefined();

    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(reportMock.mock.calls[0][0]).toBe(reason);
    expect(reportMock.mock.calls[0][1]).toEqual({
      component: 'process',
      operation: 'unhandledRejection',
      kind: 'process',
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // 回归（#221 review）：reportOperationalError 只是入队，传输是异步的。
  // 紧接着同步 process.exit 会把这份报告连同进程一起扔掉 —— 偏偏这是最需要
  // 它的一次。排空必须在退出**之前**完成，且有界（编排器等不了一个卡死的
  // 传输层）。
  it('退出前先把错误聚合排空出去，且排在 exit 之前', async () => {
    const order: string[] = [];
    flushMock.mockImplementation(async () => {
      order.push('flush');
      return true;
    });
    exitSpy.mockImplementation((() => {
      order.push('exit');
      return undefined;
    }) as never);
    uninstall = installUnhandledRejectionGuard();

    await emitRejection(new Error('boom'));

    expect(flushMock).toHaveBeenCalledWith(REJECTION_GUARD_FLUSH_TIMEOUT_MS);
    expect(order).toEqual(['flush', 'exit']);
  });

  it('排空失败也照样退出（可观测性不能挡住兜底）', async () => {
    flushMock.mockRejectedValueOnce(new Error('transport wedged'));
    uninstall = installUnhandledRejectionGuard();

    await emitRejection(new Error('boom'));

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('重复安装不会叠加监听器（模块可能被多次引导）', async () => {
    const before = process.listenerCount('unhandledRejection');
    uninstall = installUnhandledRejectionGuard();
    const second = installUnhandledRejectionGuard();

    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);

    await emitRejection(new Error('boom'));
    expect(reportMock).toHaveBeenCalledTimes(1);

    second();
  });

  it('卸载后不再接管，恢复 Node 默认行为', async () => {
    const before = process.listenerCount('unhandledRejection');
    const stop = installUnhandledRejectionGuard();
    stop();

    expect(process.listenerCount('unhandledRejection')).toBe(before);
    await emitRejection(new Error('after uninstall'));
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('terminates even when operational-error reporting itself throws', async () => {
    reportMock.mockImplementation(() => {
      throw new Error('reporter exploded');
    });
    uninstall = installUnhandledRejectionGuard();

    await expect(emitRejection(new Error('boom'))).resolves.toBeUndefined();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
