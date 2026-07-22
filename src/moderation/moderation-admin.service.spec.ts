import { ConflictException } from '@nestjs/common';
import { ModerationAdminService } from './moderation-admin.service';

describe('ModerationAdminService (PR #120 review fixes)', () => {
  function buildHarness() {
    const prisma = {
      groupReport: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
      },
      circlePostReport: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        updateMany: jest.fn(),
      },
      circlePost: {
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      circlePostCircle: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      circle: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminAuditLog: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ModerationAdminService(prisma as never, audit as never);
    return { prisma, audit, service };
  }

  it('only one of two concurrent reviews wins; the loser gets 409 and writes no audit', async () => {
    const { prisma, audit, service } = buildHarness();
    prisma.groupReport.findUnique.mockResolvedValue({
      id: 'report-1',
      status: 'PENDING',
    });
    prisma.groupReport.findUniqueOrThrow.mockResolvedValue({
      id: 'report-1',
      status: 'APPROVED',
    });
    // CAS：第一个请求转换成功，第二个 0 行
    prisma.groupReport.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    const [first, second] = await Promise.allSettled([
      service.reviewGroupReport('admin-1', 'report-1', { approve: true }),
      service.reviewGroupReport('admin-2', 'report-1', { approve: false }),
    ]);

    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('rejected');
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(
      ConflictException,
    );
    // 条件写必须带 PENDING 谓词
    expect(prisma.groupReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report-1', status: 'PENDING' },
      }),
    );
    // 只有赢家写审计
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('takedown decrements postCount for every linked circle (multi-circle post)', async () => {
    const { prisma, service } = buildHarness();
    prisma.circlePost.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'ACTIVE',
      authorID: 'author-1',
      circleID: 'circle-main',
    });
    prisma.circlePostCircle.findMany.mockResolvedValue([
      { circleID: 'circle-main' },
      { circleID: 'circle-side' },
    ]);

    await service.takedownPost('admin-1', 'post-1', 'spam');

    expect(prisma.circle.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['circle-main', 'circle-side'] } },
      data: { postCount: { decrement: 1 } },
    });
  });

  it('refuses to restore an author-deleted post (no takedown audit trail)', async () => {
    const { prisma, service } = buildHarness();
    prisma.circlePost.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'DELETED',
      circleID: 'circle-main',
    });
    // 作者自删不写 AdminAuditLog → 无 post_takedown 记录
    prisma.adminAuditLog.findFirst.mockResolvedValue(null);

    await expect(service.restorePost('admin-1', 'post-1')).rejects.toThrow(
      ConflictException,
    );
    expect(prisma.circlePost.updateMany).not.toHaveBeenCalled();
  });

  it('restores a moderation-taken-down post and re-increments postCount', async () => {
    const { prisma, service } = buildHarness();
    prisma.circlePost.findUnique.mockResolvedValue({
      id: 'post-1',
      status: 'DELETED',
      circleID: 'circle-main',
    });
    // 最近一次 takedown 晚于最近一次 restore → 当前 DELETED 归因于管理端
    prisma.adminAuditLog.findFirst.mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.action === 'post_takedown'
          ? { createdAt: new Date('2026-07-20T10:00:00Z') }
          : { createdAt: new Date('2026-07-19T10:00:00Z') },
      ),
    );
    prisma.circlePostCircle.findMany.mockResolvedValue([
      { circleID: 'circle-main' },
    ]);

    const result = await service.restorePost('admin-1', 'post-1');

    expect(result).toEqual({ id: 'post-1', status: 'ENDED' });
    expect(prisma.circlePost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'post-1', status: 'DELETED' },
        data: { status: 'ENDED' },
      }),
    );
    expect(prisma.circle.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['circle-main'] } },
      data: { postCount: { increment: 1 } },
    });
  });
});
