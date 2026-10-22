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
 * 注意边界：rejection 继续运行；uncaughtException 必须在限时刷新后非零退出。
 */
import { installUnhandledRejectionGuard } from './unhandled-rejection-guard';
import {
  flushErrorAggregation,
  reportOperationalError,
} from './error-aggregation.service';

jest.mock('./error-aggregation.service', () => ({
  reportOperationalError: jest.fn(),
  flushErrorAggregation: jest.fn().mockResolvedValue(true),
}));

const reportMock = reportOperationalError as jest.MockedFunction<
  typeof reportOperationalError
>;
const flushMock = flushErrorAggregation as jest.MockedFunction<
  typeof flushErrorAggregation
>;

describe('installUnhandledRejectionGuard', () => {
  let uninstall: (() => void) | undefined;

  beforeEach(() => {
    jest.resetAllMocks();
    flushMock.mockResolvedValue(true);
  });

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  function emitRejection(reason: unknown) {
    // 直接触发事件，不真的制造一个未处理的 promise —— 后者会污染整个 jest 进程。
    (process as NodeJS.EventEmitter).emit(
      'unhandledRejection',
      reason,
      Promise.resolve(),
    );
  }

  it('把未捕获 rejection 上报出去，而不是让进程死掉', () => {
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

  it('上报本身抛错也不能把兜底变成新的崩溃源', () => {
    reportMock.mockImplementation(() => {
      throw new Error('reporter exploded');
    });
    uninstall = installUnhandledRejectionGuard();

    expect(() => emitRejection(new Error('boom'))).not.toThrow();
  });

  // 错误聚合默认关闭（LOG_AGGREGATION_PROVIDER=none），那时上报是 no-op：
  // 只靠上报的话，生产上一条漏网的 rejection 不留任何痕迹。日志与计数器
  // 不依赖 Sentry，是这条路径上唯一保底的信号。
  describe('上报关闭或失败时仍留下日志与计数', () => {
    function rejectionAtOneSite(): Error {
      return new Error('private prose');
    }

    function errorAt(site: number): Error {
      const error = new Error('private prose');
      error.stack = `Error: private prose\n    at fn (/app/dist/site${site}.js:${site}:1)`;
      return error;
    }

    // 断言失败时也必须还原：外层 beforeEach 的 resetAllMocks 只清实现、不还原，
    // 漏还原的 Date.now 会返回 undefined，把后面的用例一起带坏。
    let clock: jest.SpyInstance<number, []> | undefined;
    afterEach(() => {
      clock?.mockRestore();
      clock = undefined;
    });
    function freezeClockAt(ms: number): jest.SpyInstance<number, []> {
      clock = jest.spyOn(Date, 'now').mockReturnValue(ms);
      return clock;
    }

    it('每次 rejection 都计数，并写一行不含错误正文的日志', () => {
      const logRejection = jest.fn();
      const countRejection = jest.fn();
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection,
      });

      emitRejection(rejectionAtOneSite());

      expect(countRejection).toHaveBeenCalledTimes(1);
      expect(logRejection).toHaveBeenCalledTimes(1);
      expect(logRejection).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[unhandledRejection\] errorName=Error source=at .*:\d+:\d+; suppressedSinceLast=0; continuing\.$/,
        ),
      );
      expect(JSON.stringify(logRejection.mock.calls)).not.toContain(
        'private prose',
      );
    });

    it('上报抛错时照样计数和写日志', () => {
      reportMock.mockImplementation(() => {
        throw new Error('reporter exploded');
      });
      const logRejection = jest.fn();
      const countRejection = jest.fn();
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection,
      });

      expect(() => emitRejection(rejectionAtOneSite())).not.toThrow();
      expect(countRejection).toHaveBeenCalledTimes(1);
      expect(logRejection).toHaveBeenCalledTimes(1);
    });

    it('计数或日志本身抛错也不能变成新的崩溃源，且互不影响', () => {
      const logRejection = jest.fn(() => {
        throw new Error('stderr gone');
      });
      const countRejection = jest.fn(() => {
        throw new Error('registry gone');
      });
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection,
      });

      expect(() => emitRejection(rejectionAtOneSite())).not.toThrow();
      expect(logRejection).toHaveBeenCalledTimes(1);
      expect(reportMock).toHaveBeenCalledTimes(1);
    });

    it('非 Error 的 rejection 只记类型，不记取值', () => {
      const logRejection = jest.fn();
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection: jest.fn(),
      });

      emitRejection('token=super-secret');

      expect(logRejection).toHaveBeenCalledWith(
        '[unhandledRejection] errorName=Unknown; suppressedSinceLast=0; continuing.',
      );
    });

    it('同一处的 rejection 风暴：全部计数，但每个位置每分钟只写一行', () => {
      const now = freezeClockAt(1_000_000);
      const logRejection = jest.fn();
      const countRejection = jest.fn();
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection,
      });

      for (let i = 0; i < 5; i++) emitRejection(errorAt(7));
      expect(countRejection).toHaveBeenCalledTimes(5);
      expect(logRejection).toHaveBeenCalledTimes(1);

      now.mockReturnValue(1_000_000 + 60_000);
      emitRejection(errorAt(7));
      expect(logRejection).toHaveBeenCalledTimes(2);
      expect(logRejection.mock.calls[1][0]).toContain('suppressedSinceLast=4');
    });

    it('不同位置各自记一行；位置种类有上限，超出的并进同一个溢出桶', () => {
      const logRejection = jest.fn();
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection: jest.fn(),
      });

      for (let site = 1; site <= 150; site++) emitRejection(errorAt(site));

      // 100 个不同位置各一行，其余 50 个只为溢出桶写第一行。
      expect(logRejection).toHaveBeenCalledTimes(101);
      expect(logRejection.mock.calls[0][0]).toContain('source=at site1.js:1:1');
      expect(logRejection.mock.calls[100][0]).toContain(
        'source=other (signature limit reached)',
      );
    });

    it('表满时先腾出窗口外的旧位置，长寿进程里的新位置不会永远落进溢出桶', () => {
      const now = freezeClockAt(1_000_000);
      const logRejection = jest.fn();
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection: jest.fn(),
      });

      for (let site = 1; site <= 100; site++) emitRejection(errorAt(site));
      now.mockReturnValue(1_000_000 + 60_000);
      emitRejection(errorAt(101));

      expect(logRejection).toHaveBeenCalledTimes(101);
      expect(logRejection.mock.calls[100][0]).toContain(
        'source=at site101.js:101:1',
      );
    });

    it('库代码里的同一帧被不同业务调用点触发时，按调用链区分并记下调用方', () => {
      // Prisma / ioredis 的 rejection 第一帧在 node_modules 里，只看第一帧的话
      // 所有调用点共用一个签名、一分钟只剩一行，也定位不到漏 .catch 的地方。
      const fromCaller = (caller: string): Error => {
        const error = new Error('private prose');
        error.stack =
          'Error: private prose\n' +
          '    at Object.request (/app/node_modules/@prisma/client/runtime/library.js:121:7315)\n' +
          `    at async ${caller}`;
        return error;
      };
      const logRejection = jest.fn();
      uninstall = installUnhandledRejectionGuard({
        logRejection,
        countRejection: jest.fn(),
      });

      emitRejection(
        fromCaller('NoteService.save (/app/dist/note.service.js:40:5)'),
      );
      emitRejection(
        fromCaller('ChatService.send (/app/dist/chat.service.js:88:3)'),
      );

      expect(logRejection).toHaveBeenCalledTimes(2);
      expect(logRejection.mock.calls[0][0]).toContain(
        'source=at library.js:121:7315 <- at note.service.js:40:5;',
      );
      expect(logRejection.mock.calls[1][0]).toContain('chat.service.js:88:3');
    });

    it('重新安装会重置去重状态', () => {
      const logRejection = jest.fn();
      const sinks = { logRejection, countRejection: jest.fn() };
      installUnhandledRejectionGuard(sinks)();
      uninstall = installUnhandledRejectionGuard(sinks);

      emitRejection(rejectionAtOneSite());
      expect(logRejection).toHaveBeenCalledTimes(1);
    });
  });

  it('captures an uncaught exception once, safely diagnoses, flushes, and exits nonzero', async () => {
    const logError = jest.fn();
    const exit = jest.fn();
    uninstall = installUnhandledRejectionGuard({ logError, exit });

    (process as NodeJS.EventEmitter).emit(
      'uncaughtException',
      new Error('private prose'),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(reportMock).toHaveBeenCalledTimes(1);
    expect(flushMock).toHaveBeenCalledWith(2000);
    expect(logError).toHaveBeenCalledWith(
      expect.stringMatching(
        /^\[fatal\] Uncaught exception; errorName=Error source=at .*:\d+:\d+; exiting\.$/,
      ),
    );
    expect(JSON.stringify(logError.mock.calls)).not.toContain('private prose');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('still exits when the bounded flush reports failure', async () => {
    flushMock.mockResolvedValue(false);
    const exit = jest.fn();
    uninstall = installUnhandledRejectionGuard({ logError: jest.fn(), exit });

    (process as NodeJS.EventEmitter).emit(
      'uncaughtException',
      new Error('boom'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(exit).toHaveBeenCalledWith(1);
  });
});
