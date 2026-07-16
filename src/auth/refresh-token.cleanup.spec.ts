import { RefreshTokenCleanup } from './refresh-token.cleanup';

describe('RefreshTokenCleanup', () => {
  const deleteMany = jest.fn();
  const prisma = { refreshToken: { deleteMany } } as never;
  const cleanup = new RefreshTokenCleanup(prisma);

  beforeEach(() => jest.clearAllMocks());

  it('deletes expired tokens and tokens revoked past the retention window', async () => {
    deleteMany.mockResolvedValue({ count: 3 });
    const now = new Date('2026-07-15T04:00:00.000Z');

    await cleanup.sweep(now);

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { expiredAt: { lt: now } },
          // 30 days before `now`.
          { revokedAt: { lt: new Date('2026-06-15T04:00:00.000Z') } },
        ],
      },
    });
  });

  it('never throws when the prune query fails', async () => {
    deleteMany.mockRejectedValue(new Error('db down'));
    await expect(cleanup.sweep(new Date())).resolves.toBeUndefined();
  });
});
