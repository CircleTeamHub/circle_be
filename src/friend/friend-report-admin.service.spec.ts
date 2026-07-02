import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreditService } from 'src/credit/credit.service';
import { FriendReportAdminService } from './friend-report-admin.service';
import { FriendReportAdminController } from './friend-report-admin.controller';

describe('FriendReportAdminService', () => {
  const tx = {
    friendReport: { updateMany: jest.fn() },
  };
  const prisma = {
    friendReport: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (client: typeof tx) => unknown) => cb(tx)),
  };
  const creditService = {
    applyDeltaInTransaction: jest.fn(),
    broadcastCreditProfileChanged: jest.fn(),
  };
  let service: FriendReportAdminService;

  const mkUser = (id: string) => ({
    id,
    nickname: `nick-${id}`,
    avatarUrl: null,
    accountId: `acct-${id}`,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (cb: (client: typeof tx) => unknown) => cb(tx),
    );
    service = new FriendReportAdminService(
      prisma as unknown as PrismaService,
      creditService as unknown as CreditService,
    );
  });

  it('lists reports for the requested status as a paginated DTO envelope', async () => {
    prisma.friendReport.findMany.mockResolvedValue([
      {
        id: 'report-1',
        category: 'harassment',
        description: 'abuse',
        evidence: ['e1'],
        status: 'PENDING',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        reviewedAt: null,
        reviewNote: null,
        reporter: mkUser('user-1'),
        target: mkUser('user-2'),
        reviewedBy: null,
      },
    ]);
    prisma.friendReport.count.mockResolvedValue(75);

    const result = await service.listReports('PENDING' as any, 2, 50);

    // page 2, limit 50 → skip 50; count 75 → hasMore (50 + 1 < 75).
    expect(prisma.friendReport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'PENDING' },
        skip: 50,
        take: 50,
      }),
    );
    expect(prisma.friendReport.count).toHaveBeenCalledWith({
      where: { status: 'PENDING' },
    });
    expect(result).toEqual(
      expect.objectContaining({
        total: 75,
        page: 2,
        limit: 50,
        hasMore: true,
        items: [
          expect.objectContaining({
            id: 'report-1',
            reporter: expect.objectContaining({ id: 'user-1' }),
          }),
        ],
      }),
    );
  });

  it('approves a pending report: marks it APPROVED, deducts credit, broadcasts', async () => {
    prisma.friendReport.findUnique
      .mockResolvedValueOnce({
        id: 'report-1',
        status: 'PENDING',
        targetID: 'user-2',
        category: 'harassment',
      })
      .mockResolvedValueOnce({
        id: 'report-1',
        category: 'harassment',
        description: 'abuse',
        evidence: [],
        status: 'APPROVED',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        reviewedAt: new Date('2026-07-02T00:00:00Z'),
        reviewNote: 'valid',
        reporter: mkUser('user-1'),
        target: mkUser('user-2'),
        reviewedBy: mkUser('admin-1'),
      });
    tx.friendReport.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.reviewReport('admin-1', 'report-1', {
      decision: 'APPROVE',
      note: 'valid',
    });

    // Optimistic lock: only flips a still-PENDING row.
    expect(tx.friendReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'report-1', status: 'PENDING' },
        data: expect.objectContaining({
          status: 'APPROVED',
          reviewedByID: 'admin-1',
          reviewNote: 'valid',
        }),
      }),
    );
    expect(creditService.applyDeltaInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: 'user-2',
        delta: -5,
        sourceType: 'FRIEND_REPORT',
        sourceId: 'report-1',
        actorId: 'admin-1',
        idempotencyKey: 'friend-report:report-1',
      }),
    );
    expect(creditService.broadcastCreditProfileChanged).toHaveBeenCalledWith(
      'user-2',
    );
    expect(result.status).toBe('APPROVED');
  });

  it('rejects a pending report without deducting credit', async () => {
    prisma.friendReport.findUnique
      .mockResolvedValueOnce({
        id: 'report-1',
        status: 'PENDING',
        targetID: 'user-2',
        category: 'spam',
      })
      .mockResolvedValueOnce({
        id: 'report-1',
        category: 'spam',
        description: 'x',
        evidence: [],
        status: 'REJECTED',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        reviewedAt: new Date('2026-07-02T00:00:00Z'),
        reviewNote: null,
        reporter: mkUser('user-1'),
        target: mkUser('user-2'),
        reviewedBy: mkUser('admin-1'),
      });
    tx.friendReport.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.reviewReport('admin-1', 'report-1', {
      decision: 'REJECT',
    });

    expect(tx.friendReport.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED' }),
      }),
    );
    expect(creditService.applyDeltaInTransaction).not.toHaveBeenCalled();
    expect(creditService.broadcastCreditProfileChanged).not.toHaveBeenCalled();
    expect(result.status).toBe('REJECTED');
  });

  it('404s when the report does not exist', async () => {
    prisma.friendReport.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.reviewReport('admin-1', 'missing', { decision: 'APPROVE' }),
    ).rejects.toThrow(NotFoundException);
    expect(tx.friendReport.updateMany).not.toHaveBeenCalled();
  });

  it('409s when the report was already reviewed', async () => {
    prisma.friendReport.findUnique.mockResolvedValueOnce({
      id: 'report-1',
      status: 'APPROVED',
      targetID: 'user-2',
      category: 'harassment',
    });

    await expect(
      service.reviewReport('admin-1', 'report-1', { decision: 'APPROVE' }),
    ).rejects.toThrow(ConflictException);
    expect(tx.friendReport.updateMany).not.toHaveBeenCalled();
  });

  it('409s when a concurrent review already flipped the row (optimistic lock)', async () => {
    prisma.friendReport.findUnique.mockResolvedValueOnce({
      id: 'report-1',
      status: 'PENDING',
      targetID: 'user-2',
      category: 'harassment',
    });
    tx.friendReport.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.reviewReport('admin-1', 'report-1', { decision: 'APPROVE' }),
    ).rejects.toThrow(ConflictException);
    expect(creditService.applyDeltaInTransaction).not.toHaveBeenCalled();
  });

  it('passes review through the controller with the current admin', async () => {
    const serviceMock = {
      reviewReport: jest.fn().mockResolvedValue({ id: 'report-1' }),
    };
    const controller = new FriendReportAdminController(serviceMock as any);

    await controller.review('report-1', { decision: 'APPROVE' }, {
      user: { userId: 'admin-1' },
    } as any);

    expect(serviceMock.reviewReport).toHaveBeenCalledWith(
      'admin-1',
      'report-1',
      {
        decision: 'APPROVE',
      },
    );
  });
});
