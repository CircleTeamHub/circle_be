import { RefreshTokenCleanup } from './refresh-token.cleanup';
import * as errorAggregation from '../logging/error-aggregation.service';
import { Logger } from '@nestjs/common';

describe('RefreshTokenCleanup', () => {
  const deleteMany = jest.fn();
  const findMany = jest.fn();
  const prisma = { refreshToken: { findMany, deleteMany } } as never;
  const cleanup = new RefreshTokenCleanup(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    findMany.mockResolvedValue([]);
  });

  it('deletes expired tokens and tokens revoked past the retention window', async () => {
    findMany.mockResolvedValueOnce([{ id: 'token-1' }, { id: 'token-2' }]);
    deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date('2026-07-15T04:00:00.000Z');

    await cleanup.sweep(now);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { expiredAt: { lt: now } },
          // 30 days before `now`.
          { revokedAt: { lt: new Date('2026-06-15T04:00:00.000Z') } },
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
            OR: [
              { expiredAt: { lt: now } },
              { revokedAt: { lt: new Date('2026-06-15T04:00:00.000Z') } },
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
});
