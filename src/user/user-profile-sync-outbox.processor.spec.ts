import { UserProfileSyncOutboxProcessor } from './user-profile-sync-outbox.processor';

describe('UserProfileSyncOutboxProcessor', () => {
  const job = {
    id: 'job-1',
    userID: 'user-1',
    status: 'PENDING',
    generation: 3,
    attempts: 0,
    user: { id: 'user-1', nickname: 'stale', avatarUrl: null },
  };

  function createHarness() {
    const prisma = {
      userProfileSyncOutbox: {
        findMany: jest.fn().mockResolvedValue([job]),
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 1 }),
        update: jest.fn(),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          nickname: 'latest',
          avatarUrl: 'https://cdn/latest.jpg',
        }),
      },
    };
    const openim = { updateUserInfo: jest.fn().mockResolvedValue(undefined) };
    const processor = new UserProfileSyncOutboxProcessor(
      prisma as any,
      openim as any,
    );
    return { prisma, openim, processor };
  }

  it('loads the latest profile after successfully claiming the generation', async () => {
    const { prisma, openim, processor } = createHarness();

    await processor.processPending();

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true, nickname: true, avatarUrl: true },
    });
    expect(openim.updateUserInfo).toHaveBeenCalledWith('user-1', {
      nickname: 'latest',
      avatarUrl: 'https://cdn/latest.jpg',
    });
  });

  it('uses generation and lease ownership for terminal writes', async () => {
    const { prisma, processor } = createHarness();

    await processor.processPending();

    const claim = prisma.userProfileSyncOutbox.updateMany.mock.calls[0][0];
    const leaseToken = claim.data.leaseToken;
    expect(leaseToken).toEqual(expect.any(String));
    expect(claim.where).toEqual(
      expect.objectContaining({ id: 'job-1', generation: 3 }),
    );
    expect(prisma.userProfileSyncOutbox.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'job-1',
        generation: 3,
        leaseToken,
        status: 'PROCESSING',
      },
      data: expect.objectContaining({
        status: 'COMPLETED',
        leaseToken: null,
      }),
    });
    expect(prisma.userProfileSyncOutbox.update).not.toHaveBeenCalled();
  });

  it('does not select a superseding generation while an older lease is active', async () => {
    const { prisma, processor } = createHarness();

    await processor.processPending();

    const selection = prisma.userProfileSyncOutbox.findMany.mock.calls[0][0];
    expect(selection.where.OR).toEqual(
      expect.arrayContaining([
        {
          status: 'PENDING',
          leaseToken: null,
          nextAttemptAt: { lte: expect.any(Date) },
        },
      ]),
    );
  });

  it('releases its lease when a newer generation supersedes completion', async () => {
    const { prisma, processor } = createHarness();
    prisma.userProfileSyncOutbox.updateMany
      .mockReset()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await processor.processPending();

    const writes = prisma.userProfileSyncOutbox.updateMany.mock.calls.map(
      ([input]) => input,
    );
    const leaseToken = writes[0].data.leaseToken;
    expect(writes).toEqual(
      expect.arrayContaining([
        {
          where: { id: 'job-1', leaseToken, status: 'PENDING' },
          data: {
            leaseToken: null,
            lockedAt: null,
            nextAttemptAt: expect.any(Date),
          },
        },
      ]),
    );
  });
});
