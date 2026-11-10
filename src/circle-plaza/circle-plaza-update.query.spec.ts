import { loadCirclePlazaUpdate } from './circle-plaza-update.query';

describe('circle plaza observation watermark', () => {
  const seenAt = new Date('2026-11-09T00:00:00.000Z');
  const postAt = new Date('2026-11-09T00:00:01.000Z');
  const observedAt = new Date('2026-11-09T00:00:02.000Z');
  const prisma = {
    $queryRaw: jest.fn(),
    user: { findUnique: jest.fn() },
    circlePost: { findFirst: jest.fn() },
  };
  beforeEach(() => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ observedAt }]);
    prisma.user.findUnique.mockResolvedValue({ circlePlazaSeenAt: seenAt });
  });
  it.each([true, false])(
    'versions hasUpdate=%s with the database observation time',
    async (hasUpdate) => {
      prisma.circlePost.findFirst.mockResolvedValue(
        hasUpdate ? { createdAt: postAt } : null,
      );
      await expect(
        loadCirclePlazaUpdate(prisma as any, 'viewer'),
      ).resolves.toEqual({
        hasUpdate,
        changedAt: observedAt.toISOString(),
      });
      const sql = prisma.$queryRaw.mock.calls[0][0].join('');
      expect(sql).toMatch(/CURRENT_TIMESTAMP/);
      expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.user.findUnique.mock.invocationCallOrder[0],
      );
      expect(prisma.circlePost.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            createdAt: { gt: seenAt, lte: observedAt },
            OR: expect.arrayContaining([{ expiresAt: { gt: observedAt } }]),
          }),
        }),
      );
    },
  );
  it.each(['expired', 'deleted'])(
    'a false snapshot after the only unread post is %s advances past that post',
    async () => {
      prisma.circlePost.findFirst
        .mockResolvedValueOnce({ createdAt: postAt })
        .mockResolvedValueOnce(null);
      const first = await loadCirclePlazaUpdate(prisma as any, 'viewer');
      const later = new Date(observedAt.getTime() + 1000);
      prisma.$queryRaw.mockResolvedValueOnce([{ observedAt: later }]);
      const second = await loadCirclePlazaUpdate(prisma as any, 'viewer');
      expect(first.hasUpdate).toBe(true);
      expect(second).toEqual({
        hasUpdate: false,
        changedAt: later.toISOString(),
      });
      expect(Date.parse(second.changedAt!)).toBeGreaterThan(postAt.getTime());
    },
  );
});
