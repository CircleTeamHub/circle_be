import { Logger } from '@nestjs/common';
import { jobMetrics } from '../metrics/job-metrics';
import { SessionRevocationOutboxProcessor } from './session-revocation-outbox.processor';

/**
 * processPending 已经被 @TrackedCron 包住，所以记账断言必须读**全局**的
 * jobMetrics（装饰器用的就是它）。刻意不在测试里再套一层 runTracked：那会
 * 变成嵌套，reportHandledJobFailure() 只会落进里层那个真正的上下文，外层
 * 看到的是一次干净返回 —— 测试于是恒绿，正好漏掉要测的东西。
 */
const REVOCATION_JOB = 'session_revocation_outbox';
const FAILURE_RUNS = new RegExp(
  `circle_cron_runs_total\\{[^}]*job="${REVOCATION_JOB}"[^}]*result="failure"[^}]*\\}\\s+(\\d+)`,
);
const LAST_RESULT = new RegExp(
  `circle_cron_last_result\\{job="${REVOCATION_JOB}"\\}\\s+([\\d.]+)`,
);
const HEARTBEAT = new RegExp(
  `circle_cron_last_success_timestamp_seconds\\{job="${REVOCATION_JOB}"\\}\\s+([\\d.]+)`,
);

async function readJobMetric(pattern: RegExp): Promise<number> {
  const match = pattern.exec(await jobMetrics.registry.metrics());
  return match ? Number(match[1]) : 0;
}

describe('SessionRevocationOutboxProcessor', () => {
  const revokedAt = new Date('2026-07-23T20:00:00.000Z');
  const futureExpiry = () => new Date(Date.now() + 60 * 60 * 1000);

  function createHarness() {
    const prisma = {
      sessionRevocationOutbox: {
        findMany: jest.fn(),
        deleteMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const sessionRevocation = {
      revokeUserAt: jest.fn(),
    };
    const processor = new SessionRevocationOutboxProcessor(
      prisma as never,
      sessionRevocation as never,
    );
    return { prisma, sessionRevocation, processor };
  }

  it('retries the original revocation epoch and removes only that job', async () => {
    const { prisma, sessionRevocation, processor } = createHarness();
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        revokedAt,
        nextAttemptAt: revokedAt,
        expiresAt: futureExpiry(),
        attempts: 0,
      },
    ]);
    prisma.sessionRevocationOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.sessionRevocationOutbox.deleteMany.mockResolvedValue({ count: 1 });
    sessionRevocation.revokeUserAt.mockResolvedValue(true);

    await expect(processor.processPending()).resolves.toBe(1);

    expect(sessionRevocation.revokeUserAt).toHaveBeenCalledWith(
      'user-1',
      revokedAt.getTime(),
    );
    expect(prisma.sessionRevocationOutbox.deleteMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', revokedAt },
    });
  });

  it('backs off while Redis or the socket broadcast remains unavailable', async () => {
    const { prisma, sessionRevocation, processor } = createHarness();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        revokedAt,
        nextAttemptAt: revokedAt,
        expiresAt: futureExpiry(),
        attempts: 2,
      },
    ]);
    prisma.sessionRevocationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sessionRevocation.revokeUserAt.mockResolvedValue(false);

    await expect(processor.processPending()).resolves.toBe(0);

    expect(prisma.sessionRevocationOutbox.deleteMany).not.toHaveBeenCalled();
    expect(prisma.sessionRevocationOutbox.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          userID: 'user-1',
          revokedAt,
          nextAttemptAt: revokedAt,
          attempts: 2,
        },
        data: { nextAttemptAt: expect.any(Date) },
      },
    );
    const claimedUntil =
      prisma.sessionRevocationOutbox.updateMany.mock.calls[0][0].data
        .nextAttemptAt;
    expect(prisma.sessionRevocationOutbox.updateMany).toHaveBeenNthCalledWith(
      2,
      {
        where: { userID: 'user-1', revokedAt, nextAttemptAt: claimedUntil },
        data: {
          attempts: { increment: 1 },
          lastError: 'Redis revocation or socket broadcast unavailable',
          nextAttemptAt: expect.any(Date),
        },
      },
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Session revocation retry failed',
        error: 'Redis revocation or socket broadcast unavailable',
        userID: 'user-1',
        revokedAt: revokedAt.toISOString(),
        attempts: 3,
      }),
    );
    warn.mockRestore();
  });

  it('records a failed run when a claimed revocation could not be applied', async () => {
    // review #150：异常在 catch 里被吞掉、方法正常返回，包装器只看「有没有抛」
    // 就会把这一轮记成功并推进心跳 —— Redis / 广播长时间不可用时
    // CronJobFailing 和 CronJobStalled 双双打不中，而一条撤销都没生效。
    const { prisma, sessionRevocation, processor } = createHarness();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        revokedAt,
        nextAttemptAt: revokedAt,
        expiresAt: futureExpiry(),
        attempts: 0,
      },
    ]);
    prisma.sessionRevocationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sessionRevocation.revokeUserAt.mockRejectedValue(new Error('redis down'));

    const failuresBefore = await readJobMetric(FAILURE_RUNS);
    const heartbeatBefore = await readJobMetric(HEARTBEAT);

    await expect(processor.processPending()).resolves.toBe(0);

    expect(await readJobMetric(FAILURE_RUNS)).toBe(failuresBefore + 1);
    expect(await readJobMetric(LAST_RESULT)).toBe(0);
    // 心跳不许前进：前进了 CronJobStalled 也会一起哑掉，两条告警同时失明。
    expect(await readJobMetric(HEARTBEAT)).toBe(heartbeatBefore);
    // 记失败不能打断重试循环 —— 这一行仍然要退避重排。
    expect(prisma.sessionRevocationOutbox.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({ attempts: { increment: 1 } }),
      }),
    );
    warn.mockRestore();
  });

  it('keeps draining the batch after one revocation fails', async () => {
    // 失败记账不得改变遍历行为：第一行挂掉，后面的行照样要被处理完。
    const { prisma, sessionRevocation, processor } = createHarness();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        revokedAt,
        nextAttemptAt: revokedAt,
        expiresAt: futureExpiry(),
        attempts: 0,
      },
      {
        userID: 'user-2',
        revokedAt,
        nextAttemptAt: revokedAt,
        expiresAt: futureExpiry(),
        attempts: 0,
      },
    ]);
    prisma.sessionRevocationOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.sessionRevocationOutbox.deleteMany.mockResolvedValue({ count: 1 });
    sessionRevocation.revokeUserAt
      .mockRejectedValueOnce(new Error('redis down'))
      .mockResolvedValueOnce(true);

    await expect(processor.processPending()).resolves.toBe(1);

    expect(sessionRevocation.revokeUserAt).toHaveBeenCalledTimes(2);
    expect(prisma.sessionRevocationOutbox.deleteMany).toHaveBeenCalledWith({
      where: { userID: 'user-2', revokedAt },
    });
    warn.mockRestore();
  });

  it('removes an expired revocation without touching Redis', async () => {
    const { prisma, sessionRevocation, processor } = createHarness();
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        revokedAt,
        nextAttemptAt: revokedAt,
        expiresAt: new Date(Date.now() - 60 * 1000),
        attempts: 2,
      },
    ]);
    prisma.sessionRevocationOutbox.deleteMany.mockResolvedValue({ count: 1 });

    await expect(processor.processPending()).resolves.toBe(1);

    expect(sessionRevocation.revokeUserAt).not.toHaveBeenCalled();
    expect(prisma.sessionRevocationOutbox.deleteMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', revokedAt },
    });
  });

  it('lets only one concurrent processor claim a due revocation job', async () => {
    const job = {
      userID: 'user-1',
      revokedAt,
      nextAttemptAt: revokedAt,
      expiresAt: futureExpiry(),
      attempts: 0,
    };
    const { prisma, sessionRevocation } = createHarness();
    const first = new SessionRevocationOutboxProcessor(
      prisma as never,
      sessionRevocation as never,
    );
    const second = new SessionRevocationOutboxProcessor(
      prisma as never,
      sessionRevocation as never,
    );
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([job]);
    prisma.sessionRevocationOutbox.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.sessionRevocationOutbox.deleteMany.mockResolvedValue({ count: 1 });
    sessionRevocation.revokeUserAt.mockResolvedValue(true);

    await expect(
      Promise.all([first.processPending(), second.processPending()]),
    ).resolves.toEqual([1, 0]);

    expect(sessionRevocation.revokeUserAt).toHaveBeenCalledTimes(1);
  });
});
