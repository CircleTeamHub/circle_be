import { Logger } from '@nestjs/common';
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
