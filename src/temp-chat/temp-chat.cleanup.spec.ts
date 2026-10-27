import { Prisma, TempChatStatus } from 'src/generated/prisma';
import { TempChatCleanup } from './temp-chat.cleanup';
import { dueTempChatsQuery } from './temp-chat-cleanup.query';
import * as errorAggregation from '../logging/error-aggregation.service';

describe('TempChatCleanup', () => {
  const prisma = { $queryRaw: jest.fn() };
  const service = { teardown: jest.fn() };
  const job = new TempChatCleanup(prisma as any, service as any);

  beforeEach(() => jest.clearAllMocks());

  it('tears down every due room', async () => {
    prisma.$queryRaw.mockResolvedValue([
      { id: 'a', groupId: 'tmpA' },
      { id: 'b', groupId: 'tmpB' },
    ]);
    await job.sweep();
    expect(service.teardown).toHaveBeenCalledTimes(2);
    expect(service.teardown).toHaveBeenCalledWith(
      { id: 'a', groupId: 'tmpA' },
      TempChatStatus.EXPIRED,
    );
  });

  it('one failing room does not block the others', async () => {
    const report = jest
      .spyOn(errorAggregation, 'reportOperationalError')
      .mockImplementation(() => undefined);
    prisma.$queryRaw.mockResolvedValue([
      { id: 'a', groupId: 'tmpA' },
      { id: 'b', groupId: 'tmpB' },
    ]);
    service.teardown.mockRejectedValueOnce(new Error('boom'));
    await job.sweep();
    expect(service.teardown).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      component: 'TempChatCleanup',
      operation: 'teardownExpiredRoom',
      kind: 'scheduler',
    });
    report.mockRestore();
  });

  // 房间上限是按主机算的、TTL 又普遍相同,一次大批量到期会把无界查询
  // 变成一次超长 sweep。分批 + 按 expiresAt 升序:最老的房间一定先被清掉,
  // 不会出现「每轮都在处理同一批、排在后面的永远轮不到」。
  it('claims bounded, oldest-first batches instead of loading every due room', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await job.sweep();
    const [[query]] = prisma.$queryRaw.mock.calls as [[Prisma.Sql]];
    expect(query.sql).toMatch(/ORDER BY due\."expiresAt" ASC\s+LIMIT \?\s*$/);
    expect(query.values).toContain(200);
  });

  it('keeps draining while batches come back full', async () => {
    const full = Array.from({ length: 200 }, (_, i) => ({
      id: `r${i}`,
      groupId: `tmp${i}`,
    }));
    prisma.$queryRaw
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([{ id: 'last', groupId: 'tmpLast' }]);

    await job.sweep();

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(service.teardown).toHaveBeenCalledTimes(201);
  });

  // @Cron 到点就调,不等上一次返回。没有重入闸的话,一次跑超过一分钟的 sweep
  // 会被下一次叠上来,两轮各做一遍全表扫描、互相抢同一批房间的租约。
  it('does not start a second sweep while one is still running', async () => {
    let release!: () => void;
    prisma.$queryRaw.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve([]);
      }),
    );

    const first = job.sweep();
    await job.sweep(); // 重入:必须直接返回,不发起任何查询
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('reports a batch-claim failure and releases the reentry guard', async () => {
    const report = jest
      .spyOn(errorAggregation, 'reportOperationalError')
      .mockImplementation(() => undefined);
    prisma.$queryRaw.mockRejectedValueOnce(new Error('db down'));

    await expect(job.sweep()).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      component: 'TempChatCleanup',
      operation: 'claimBatch',
      kind: 'scheduler',
    });

    prisma.$queryRaw.mockResolvedValueOnce([]);
    await job.sweep();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    report.mockRestore();
  });
});

describe('dueTempChatsQuery', () => {
  const now = new Date('2026-10-26T00:00:00.000Z');
  const stale = new Date('2026-10-25T23:58:00.000Z');

  /**
   * 原来是一条 OR:第二支(已结束、未清理完)用不上 (status, expiresAt) 之外的任何
   * 索引,TempChat 又从不删行,每分钟都要把全部历史房间扫一遍。拆成两支各自
   * 按 expiresAt 取前 limit 条再合并,第二支落在只收「待清理」房间的部分索引上。
   */
  it('reads each branch separately, oldest first, and merges under the same cap', () => {
    const query = dueTempChatsQuery(now, stale, 200);
    const sql = query.sql.replace(/\s+/g, ' ');

    expect(sql).toContain('UNION ALL');
    // 只剩租约过期判断那一个 OR,两支之间不再用 OR 连接。
    expect(sql.match(/\bOR\b/g)).toHaveLength(1);
    expect(sql).toContain(
      `(t."cleanupLockedAt" IS NULL OR t."cleanupLockedAt" < ?::timestamp)`,
    );
    // 两支都是字面量枚举:参数化的 CAST(... AS "TempChatStatus") 走 enum_in(STABLE),
    // 规划时折不成常量,部分索引的谓词就证明不了。
    expect(sql).toContain(`t."status" = 'ACTIVE'`);
    expect(sql).toContain(`t."status" IN ('ENDED', 'EXPIRED')`);
    expect(sql).toContain(`t."cleanupCompletedAt" IS NULL`);
    expect(sql.match(/ORDER BY t\."expiresAt" ASC LIMIT \?/g)).toHaveLength(2);
    expect(sql).toMatch(/ORDER BY due\."expiresAt" ASC LIMIT \?\s*$/);
    expect(query.values).toEqual([now, 200, stale, 200, 200]);
  });
});
