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
