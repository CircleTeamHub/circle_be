import {
  isRetryableTransactionError,
  runSerializableTransaction,
} from './prisma-tx';

// Prisma 对原生 SQL（$queryRaw / $executeRaw）的数据库错误一律包成 P2010，
// 其余未识别的数据库错误包成 P2039；原始 SQLSTATE 在 driverAdapterError 里。
function driverError(code: 'P2010' | 'P2039', sqlState: string) {
  return {
    code,
    meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
  };
}

describe('isRetryableTransactionError', () => {
  it('retries a write conflict and raw-query serialization failures or deadlocks', () => {
    expect(isRetryableTransactionError({ code: 'P2034' })).toBe(true);
    expect(isRetryableTransactionError(driverError('P2010', '40001'))).toBe(
      true,
    );
    expect(isRetryableTransactionError(driverError('P2010', '40P01'))).toBe(
      true,
    );
    expect(isRetryableTransactionError(driverError('P2039', '40P01'))).toBe(
      true,
    );
  });

  it('does not retry other raw-query failures or ordinary errors', () => {
    expect(isRetryableTransactionError(driverError('P2010', '23505'))).toBe(
      false,
    );
    expect(isRetryableTransactionError({ code: 'P2002' })).toBe(false);
    expect(isRetryableTransactionError(new Error('boom'))).toBe(false);
    expect(isRetryableTransactionError(null)).toBe(false);
  });
});

describe('runSerializableTransaction', () => {
  it('retries a raw-query serialization failure and returns the next attempt', async () => {
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValueOnce(driverError('P2010', '40001'))
        .mockResolvedValueOnce('ok'),
    };
    await expect(
      runSerializableTransaction(prisma as any, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('propagates a non-retryable error immediately', async () => {
    const unique = { code: 'P2002' };
    const prisma = { $transaction: jest.fn().mockRejectedValue(unique) };
    await expect(
      runSerializableTransaction(prisma as any, async () => 'ok'),
    ).rejects.toBe(unique);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('runSerializableTransaction backoff', () => {
  const conflict = () => driverError('P2010', '40001');

  beforeEach(() => {
    jest.useFakeTimers();
    // 抖动取上界,等待时长可预期:第 n 次重试前等 base·2^(n-1)。
    jest.spyOn(Math, 'random').mockReturnValue(0.999999);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('waits an exponentially growing, jittered delay before each retry', async () => {
    const prisma = { $transaction: jest.fn().mockRejectedValue(conflict()) };
    const settled = jest.fn();
    const running = runSerializableTransaction(prisma as any, async () => 'x')
      .then(settled, settled)
      .then(() => undefined);

    // 第一次立刻发出,失败后不能立刻重试。
    await jest.advanceTimersByTimeAsync(0);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(24);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);

    // 50ms、100ms、200ms:间隔翻倍。
    await jest.advanceTimersByTimeAsync(49);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(100);
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);

    // 默认 5 次用完即抛最后一次的错误,不再排下一次。
    await running;
    expect(settled).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'P2010' }),
    );
    await jest.advanceTimersByTimeAsync(10_000);
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
  });

  it('keeps at least half of the backoff window even with the smallest jitter', async () => {
    (Math.random as jest.Mock).mockReturnValue(0);
    const prisma = {
      $transaction: jest
        .fn()
        .mockRejectedValueOnce(conflict())
        .mockResolvedValueOnce('ok'),
    };
    const running = runSerializableTransaction(prisma as any, async () => 'ok');

    // 25ms 窗口的一半向下取整 = 12ms。
    await jest.advanceTimersByTimeAsync(11);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    await expect(running).resolves.toBe('ok');
  });

  it('caps a single wait and honours an explicit maxAttempts', async () => {
    const prisma = { $transaction: jest.fn().mockRejectedValue(conflict()) };
    const settled = jest.fn();
    void runSerializableTransaction(prisma as any, async () => 'x', {
      maxAttempts: 8,
      baseDelayMs: 100,
      maxDelayMs: 300,
    }).then(settled, settled);

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(100); // 2nd
    await jest.advanceTimersByTimeAsync(200); // 3rd
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    // 400 被封顶成 300。
    await jest.advanceTimersByTimeAsync(299);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(4);
    await jest.advanceTimersByTimeAsync(300 * 4);
    expect(prisma.$transaction).toHaveBeenCalledTimes(8);
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it('never delays a non-retryable error or a first-try success', async () => {
    const unique = { code: 'P2002' };
    const failing = { $transaction: jest.fn().mockRejectedValue(unique) };
    await expect(
      runSerializableTransaction(failing as any, async () => 'x'),
    ).rejects.toBe(unique);
    const ok = { $transaction: jest.fn().mockResolvedValue('ok') };
    await expect(
      runSerializableTransaction(ok as any, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('forwards transaction timeout options to Prisma', async () => {
    const prisma = { $transaction: jest.fn().mockResolvedValue('ok') };
    await runSerializableTransaction(prisma as any, async () => 'ok', {
      timeout: 15_000,
      maxWait: 4_000,
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
      timeout: 15_000,
      maxWait: 4_000,
    });
  });
});
