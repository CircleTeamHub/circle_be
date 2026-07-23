import { SessionRevocationOutboxProcessor } from './session-revocation-outbox.processor';

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
        expiresAt: futureExpiry(),
        attempts: 0,
      },
    ]);
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
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        revokedAt,
        expiresAt: futureExpiry(),
        attempts: 2,
      },
    ]);
    prisma.sessionRevocationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sessionRevocation.revokeUserAt.mockResolvedValue(false);

    await expect(processor.processPending()).resolves.toBe(0);

    expect(prisma.sessionRevocationOutbox.deleteMany).not.toHaveBeenCalled();
    expect(prisma.sessionRevocationOutbox.updateMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', revokedAt },
      data: {
        attempts: { increment: 1 },
        lastError: 'Redis revocation or socket broadcast unavailable',
        nextAttemptAt: expect.any(Date),
      },
    });
  });

  it('removes an expired revocation without touching Redis', async () => {
    const { prisma, sessionRevocation, processor } = createHarness();
    prisma.sessionRevocationOutbox.findMany.mockResolvedValue([
      {
        userID: 'user-1',
        revokedAt,
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
});
