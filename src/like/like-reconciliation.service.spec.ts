import { CronExpression } from '@nestjs/schedule';
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';
import { LikeReconciliationService } from './like-reconciliation.service';

// 对账是全表重算,期间持有 like-counter-reconciliation 独占锁,所有点赞都要等它。
// 只用来修「点赞人被硬删、级联删行不减计数」这一种漂移,一天一次足够;
// 此前误配成每小时,和类注释的 daily 不一致。
describe('LikeReconciliationService schedule', () => {
  it('runs once a day in the East Asia small hours, not every hour', () => {
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      LikeReconciliationService.prototype.reconcileReceivedLikeCounts,
    ) as { cronTime: string; timeZone?: string };

    expect(options.cronTime).toBe(CronExpression.EVERY_DAY_AT_4AM);
    // 容器 TZ=UTC,UTC 04:00 是北京时间正午;按用户时区落在凌晨 4 点。
    expect(options.timeZone).toBe('Asia/Shanghai');
  });
});

describe('LikeReconciliationService', () => {
  const prisma = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn((cb: any) => cb(prisma)),
  };
  const service = new LikeReconciliationService(prisma as any);
  const sqlOf = (query: unknown): string =>
    (query as { strings?: readonly string[] }).strings?.join('?') ??
    (query as TemplateStringsArray).join('?');
  const executedSql = (): string[] =>
    prisma.$executeRaw.mock.calls.map((call) => sqlOf(call[0]));

  beforeEach(() => jest.clearAllMocks());

  it('recomputes receivedLikeCount from the actual like rows and reports repairs', async () => {
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.$executeRaw.mockResolvedValue(3);

    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(3);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeout: 300_000,
        isolationLevel: 'Serializable',
      }),
    );
    // Set-based UPDATE keyed on a per-user COUNT of UserLike rows.
    const sql = executedSql().find((text) => text.includes('UPDATE "User"'));
    expect(sql).toContain('"UserLike"');
  });

  // 点赞/取消点赞持有这把锁的共享锁(只持几毫秒)。原来用 try-lock:北京时间 04:00
  // 只要有一笔点赞在途,对账就直接返回 0、和「没有漂移」无法区分,改成一天一次后
  // 一跳就是一整天。现在阻塞等锁(带 5 秒上限),拿到后恢复默认,不影响后面的 UPDATE。
  it('waits briefly for in-flight likes instead of silently skipping the day', async () => {
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.$executeRaw.mockResolvedValue(0);

    await service.reconcileReceivedLikeCounts();

    // pg_advisory_xact_lock 返回 void,必须走 $executeRaw(见 advisory-lock 守卫 spec)。
    const executed = executedSql();
    expect(executed[0]).toContain("SET LOCAL lock_timeout = '5s'");
    expect(executed[1]).toContain('pg_advisory_xact_lock(');
    expect(executed[1]).not.toContain('pg_try_advisory_xact_lock');
    expect(executed[2]).toContain('SET LOCAL lock_timeout = DEFAULT');
    expect(executed[3]).toContain('UPDATE "User"');
  });

  it('surfaces a lock timeout as a failed run instead of reporting no drift', async () => {
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.$executeRaw
      .mockResolvedValueOnce(0) // SET LOCAL lock_timeout
      .mockRejectedValueOnce(
        Object.assign(new Error('lock timeout'), {
          code: 'P2010',
          meta: { driverAdapterError: { cause: { originalCode: '55P03' } } },
        }),
      );

    await expect(service.reconcileReceivedLikeCounts()).rejects.toThrow(
      'lock timeout',
    );
    expect(executedSql().some((text) => text.includes('UPDATE "User"'))).toBe(
      false,
    );
  });

  // 原生查询的序列化失败报 P2010(原始 SQLSTATE 40001),不是 P2034。
  it('retries a raw-query serialization failure too', async () => {
    prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('could not serialize'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
      }),
    );
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.$executeRaw.mockResolvedValue(1);

    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('is a no-op report when nothing drifted', async () => {
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.$executeRaw.mockResolvedValue(0);
    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(0);
  });

  it('skips reconciliation when another instance owns the advisory lock', async () => {
    prisma.$queryRaw.mockResolvedValue([{ acquired: false }]);

    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(0);

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('retries a serialization conflict instead of applying a stale snapshot', async () => {
    prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('write conflict'), { code: 'P2034' }),
    );
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.$executeRaw.mockResolvedValue(2);

    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(2);

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});
