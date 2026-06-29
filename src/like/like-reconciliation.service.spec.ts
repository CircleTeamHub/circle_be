import { LikeReconciliationService } from './like-reconciliation.service';

describe('LikeReconciliationService', () => {
  const prisma = { $executeRaw: jest.fn() };
  const service = new LikeReconciliationService(prisma as any);

  beforeEach(() => jest.clearAllMocks());

  it('recomputes receivedLikeCount from the actual like rows and reports repairs', async () => {
    prisma.$executeRaw.mockResolvedValue(3);

    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(3);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    // Set-based UPDATE keyed on a per-user COUNT of UserLike rows.
    const sql = String(prisma.$executeRaw.mock.calls[0][0]);
    expect(sql).toContain('UPDATE "User"');
    expect(sql).toContain('"UserLike"');
  });

  it('is a no-op report when nothing drifted', async () => {
    prisma.$executeRaw.mockResolvedValue(0);
    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(0);
  });
});
