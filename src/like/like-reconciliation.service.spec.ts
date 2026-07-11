import { LikeReconciliationService } from './like-reconciliation.service';

describe('LikeReconciliationService', () => {
  const prisma = {
    $executeRaw: jest.fn(),
    $queryRaw: jest.fn(),
    $transaction: jest.fn((cb: any) => cb(prisma)),
  };
  const service = new LikeReconciliationService(prisma as any);

  beforeEach(() => jest.clearAllMocks());

  it('recomputes receivedLikeCount from the actual like rows and reports repairs', async () => {
    prisma.$queryRaw.mockResolvedValue([{ acquired: true }]);
    prisma.$executeRaw.mockResolvedValue(3);

    await expect(service.reconcileReceivedLikeCounts()).resolves.toBe(3);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        timeout: 300_000,
        isolationLevel: 'Serializable',
      }),
    );
    // Set-based UPDATE keyed on a per-user COUNT of UserLike rows.
    const sql = String(prisma.$executeRaw.mock.calls[0][0]);
    expect(sql).toContain('UPDATE "User"');
    expect(sql).toContain('"UserLike"');
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
