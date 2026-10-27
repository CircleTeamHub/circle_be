import { WarnSampler } from './warn-sampler';

describe('WarnSampler', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const sampler = (perWindow: number, windowMs: number) =>
    new WarnSampler(perWindow, windowMs, () => Date.now());

  it('admits a fixed number of lines per key per window', () => {
    const s = sampler(2, 1_000);
    const onSuppressed = jest.fn();
    expect([1, 2, 3, 4].map(() => s.admit('a', onSuppressed))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // 另一个 key 有自己的额度。
    expect(s.admit('b', onSuppressed)).toBe(true);
    jest.advanceTimersByTime(999);
    expect(s.admit('a', onSuppressed)).toBe(false);
    expect(onSuppressed).not.toHaveBeenCalled();
    s.dispose();
  });

  it('reports what a window dropped when it ends, even if nothing follows', () => {
    // 一阵突发停了、这个 key 再也不来：补报不能等「下一行」。
    const s = sampler(1, 1_000);
    const onSuppressed = jest.fn();
    s.admit('a', onSuppressed);
    s.admit('a', onSuppressed);
    s.admit('a', onSuppressed);
    jest.advanceTimersByTime(999);
    expect(onSuppressed).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onSuppressed).toHaveBeenCalledTimes(1);
    expect(onSuppressed).toHaveBeenCalledWith(2);
    // 下一个窗口开头不再重复补报。
    expect(s.admit('a', onSuppressed)).toBe(true);
    expect(onSuppressed).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('reports on the next admit when the window is already over', () => {
    const s = sampler(1, 1_000);
    const onSuppressed = jest.fn();
    s.admit('a', onSuppressed);
    s.admit('a', onSuppressed);
    // 时间跳过了窗口结束、计时器还没来得及跑。
    jest.setSystemTime(Date.now() + 5_000);
    expect(s.admit('a', onSuppressed)).toBe(true);
    expect(onSuppressed).toHaveBeenCalledWith(1);
    jest.runOnlyPendingTimers();
    expect(onSuppressed).toHaveBeenCalledTimes(1);
    s.dispose();
  });

  it('stays quiet for a window that dropped nothing, and after dispose', () => {
    const s = sampler(5, 1_000);
    const onSuppressed = jest.fn();
    s.admit('a', onSuppressed);
    jest.advanceTimersByTime(5_000);
    expect(onSuppressed).not.toHaveBeenCalled();
    s.admit('a', onSuppressed);
    s.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });
});
