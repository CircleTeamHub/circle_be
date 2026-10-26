import { RefreshTokenCleanup } from './refresh-token.cleanup';
import * as errorAggregation from '../logging/error-aggregation.service';
import { Logger } from '@nestjs/common';

describe('RefreshTokenCleanup', () => {
  const deleteMany = jest.fn();
  const findMany = jest.fn();
  const challengeDeleteMany = jest.fn();
  const challengeFindMany = jest.fn();
  const emailCodeDeleteMany = jest.fn();
  const emailCodeFindMany = jest.fn();
  const prisma = {
    refreshToken: { findMany, deleteMany },
    loginChallenge: {
      deleteMany: challengeDeleteMany,
      findMany: challengeFindMany,
    },
    emailVerificationCode: {
      deleteMany: emailCodeDeleteMany,
      findMany: emailCodeFindMany,
    },
  } as never;
  const redis = {
    tryAcquireLease: jest.fn(),
    renewLease: jest.fn(),
    releaseLease: jest.fn(),
  };
  const cleanup = new RefreshTokenCleanup(prisma, redis as never);

  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
    challengeDeleteMany.mockResolvedValue({ count: 0 });
    challengeFindMany.mockResolvedValue([]);
    emailCodeDeleteMany.mockResolvedValue({ count: 0 });
    emailCodeFindMany.mockResolvedValue([]);
    redis.tryAcquireLease.mockResolvedValue(undefined);
    redis.renewLease.mockResolvedValue(true);
  });

  it('caps challenge deletion at twenty indexed batches per run', async () => {
    challengeFindMany.mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => ({ id: `c-${i}` })),
    );
    challengeDeleteMany.mockResolvedValue({ count: 1000 });
    await cleanup.sweep();
    expect(challengeFindMany).toHaveBeenCalledTimes(20);
    expect(challengeDeleteMany).toHaveBeenCalledTimes(20);
    expect(challengeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 1000, orderBy: { id: 'asc' } }),
    );
    expect(challengeDeleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: expect.any(Array) },
          expiresAt: expect.any(Object),
        }),
      }),
    );
  });

  it('allows only one replica to scan and skips local overlap', async () => {
    let finish!: (value: unknown[]) => void;
    findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    redis.tryAcquireLease
      .mockResolvedValueOnce('owner')
      .mockResolvedValueOnce(null);
    const first = cleanup.sweep();
    await Promise.resolve();
    await cleanup.sweep();
    const second = new RefreshTokenCleanup(prisma, redis as never);
    await second.sweep();
    expect(findMany).toHaveBeenCalledTimes(1);
    finish([]);
    await first;
    expect(redis.releaseLease).toHaveBeenCalledWith(
      'job-lease:refresh_token_cleanup',
      'owner',
    );
  });

  it('does not delete selected tokens after renewal loses ownership', async () => {
    jest.useFakeTimers();
    redis.tryAcquireLease.mockResolvedValue('owner');
    redis.renewLease.mockResolvedValue(false);
    let finish!: (value: unknown[]) => void;
    findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = cleanup.sweep();
    try {
      await jest.advanceTimersByTimeAsync(21_000);
      finish([{ id: 'old' }]);
      await running;
      expect(deleteMany).not.toHaveBeenCalled();
    } finally {
      await running;
      jest.useRealTimers();
    }
  });

  it('deletes expired tokens and tokens revoked past the retention window', async () => {
    findMany.mockResolvedValueOnce([{ id: 'token-1' }, { id: 'token-2' }]);
    deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date('2026-07-15T04:00:00.000Z');

    await cleanup.sweep(now);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            OR: [
              { expiredAt: { lt: now } },
              // 30 days before `now`.
              { revokedAt: { lt: new Date('2026-06-15T04:00:00.000Z') } },
            ],
          },
          {
            OR: [
              { accessTokenExpiresAt: { lte: now } },
              {
                accessTokenExpiresAt: null,
                expiredAt: { lte: now },
              },
            ],
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 1000,
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        AND: [
          {
            AND: [
              {
                OR: [
                  { expiredAt: { lt: now } },
                  {
                    revokedAt: {
                      lt: new Date('2026-06-15T04:00:00.000Z'),
                    },
                  },
                ],
              },
              {
                OR: [
                  { accessTokenExpiresAt: { lte: now } },
                  {
                    accessTokenExpiresAt: null,
                    expiredAt: { lte: now },
                  },
                ],
              },
            ],
          },
          { id: { in: ['token-1', 'token-2'] } },
        ],
      },
    });
  });

  it('never throws when the prune query fails', async () => {
    const report = jest
      .spyOn(errorAggregation, 'reportOperationalError')
      .mockImplementation(() => undefined);
    findMany.mockRejectedValue(new Error('db down'));
    await expect(cleanup.sweep(new Date())).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      component: 'RefreshTokenCleanup',
      operation: 'sweep',
      kind: 'scheduler',
    });
    report.mockRestore();
  });

  it('drains a backlog across bounded frequent sweeps and reports a capped run', async () => {
    let remaining = 21_000;
    findMany.mockImplementation(() =>
      Promise.resolve(
        Array.from({ length: Math.min(remaining, 1000) }, (_, index) => ({
          id: `t-${index}`,
        })),
      ),
    );
    deleteMany.mockImplementation(({ where }) => {
      const count = where.AND[1].id.in.length;
      remaining -= count;
      return Promise.resolve({ count });
    });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await cleanup.sweep(new Date());
      expect(remaining).toBe(1000);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'refresh_token_cleanup_capped',
          nextRunInMinutes: 10,
        }),
      );
      await cleanup.sweep(new Date());
      expect(remaining).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it('logs a fixed prune failure without private database error text', async () => {
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const error = new Error('SELECT private_messages private-value');
    findMany.mockRejectedValueOnce(error);
    try {
      await expect(cleanup.sweep(new Date())).resolves.toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'refresh_token_cleanup_failed',
          operation: 'sweep',
        }),
      );
      expect(JSON.stringify(log.mock.calls)).not.toMatch(
        /SELECT|private_messages|private-value/,
      );
    } finally {
      log.mockRestore();
    }
  });

  it('prunes login challenges by expiry, so a pending recovery outlives its creation day', async () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    challengeFindMany.mockResolvedValueOnce([{ id: 'old' }]);
    await cleanup.sweep(now);
    // 按 expiresAt 而不是 createdAt：找回申请的有效期延长到等待期之后，按创建时间
    // 清会在它刚能完成（创建满 24 小时）时把它删掉。
    expect(challengeFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { expiresAt: { lt: new Date('2026-10-13T12:00:00.000Z') } },
      }),
    );
    expect(challengeDeleteMany).toHaveBeenCalledWith({
      where: {
        expiresAt: { lt: new Date('2026-10-13T12:00:00.000Z') },
        id: { in: ['old'] },
      },
    });
  });

  // EmailVerificationCode 此前没有任何清理任务,只增不减。码 10 分钟过期、只认
  // (email, purpose) 的最新一行;过期满一天的行既不能再验证,也早已不是任何
  // 有效码的「更新的一行」,删掉不改变 verifyCode / 发码冷却的判定。
  it('prunes email verification codes a day past their expiry in indexed batches', async () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    const cutoff = new Date('2026-10-13T12:00:00.000Z');
    emailCodeFindMany.mockResolvedValueOnce([
      { id: 'code-1' },
      { id: 'code-2' },
    ]);
    emailCodeDeleteMany.mockResolvedValueOnce({ count: 2 });

    await cleanup.sweep(now);

    // 按 expiresAt 排序取批:新索引 EmailVerificationCode_expiresAt_idx 同时给出
    // 范围与顺序,每批只读 1000 个索引项,积压再多也不用排序。
    expect(emailCodeFindMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: cutoff } },
      select: { id: true },
      orderBy: { expiresAt: 'asc' },
      take: 1000,
    });
    expect(emailCodeDeleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: cutoff }, id: { in: ['code-1', 'code-2'] } },
    });
    expect(emailCodeFindMany).toHaveBeenCalledTimes(1);
  });

  it('caps email code deletion at twenty batches per run', async () => {
    emailCodeFindMany.mockResolvedValue(
      Array.from({ length: 1000 }, (_, i) => ({ id: `e-${i}` })),
    );
    emailCodeDeleteMany.mockResolvedValue({ count: 1000 });
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      await cleanup.sweep(new Date());
      expect(emailCodeFindMany).toHaveBeenCalledTimes(20);
      expect(emailCodeDeleteMany).toHaveBeenCalledTimes(20);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'email_code_cleanup_capped',
          deletedCount: 20_000,
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('does not delete selected email codes after the lease is lost', async () => {
    jest.useFakeTimers();
    redis.tryAcquireLease.mockResolvedValue('owner');
    redis.renewLease.mockResolvedValue(false);
    let finish!: (value: unknown[]) => void;
    emailCodeFindMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const running = cleanup.sweep();
    try {
      await jest.advanceTimersByTimeAsync(21_000);
      finish([{ id: 'old' }]);
      await running;
      expect(emailCodeDeleteMany).not.toHaveBeenCalled();
    } finally {
      await running;
      jest.useRealTimers();
    }
  });
});
