import { enqueueCircleMemberSync } from './circle-member-sync';

describe('enqueueCircleMemberSync', () => {
  const tx = {
    groupSyncOutbox: {
      updateMany: jest.fn(),
      createMany: jest.fn(),
    },
  };

  beforeEach(() => jest.clearAllMocks());

  it('supersedes every open generation before queueing a fresh desired state', async () => {
    await enqueueCircleMemberSync(tx as any, 'REMOVE_MEMBER', 'group-1', [
      'user-b',
      'user-a',
      'user-b',
    ]);

    expect(tx.groupSyncOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        groupID: 'group-1',
        userID: { in: ['user-a', 'user-b'] },
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
      },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lockedAt: null,
        lastError: 'Superseded by desired REMOVE_MEMBER state',
      },
    });
    expect(
      tx.groupSyncOutbox.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(tx.groupSyncOutbox.createMany.mock.invocationCallOrder[0]);
    expect(tx.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        { operation: 'REMOVE_MEMBER', groupID: 'group-1', userID: 'user-a' },
        { operation: 'REMOVE_MEMBER', groupID: 'group-1', userID: 'user-b' },
      ],
      skipDuplicates: true,
    });
  });

  it('creates a fresh generation even when the open operation already matches', async () => {
    await enqueueCircleMemberSync(tx as any, 'ADD_MEMBER', 'group-1', [
      'user-1',
    ]);

    expect(tx.groupSyncOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.not.objectContaining({ operation: expect.anything() }),
      }),
    );
    expect(tx.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [{ operation: 'ADD_MEMBER', groupID: 'group-1', userID: 'user-1' }],
      skipDuplicates: true,
    });
  });

  it('does not query the outbox for an empty desired-state batch', async () => {
    await enqueueCircleMemberSync(tx as any, 'ADD_MEMBER', 'group-1', []);

    expect(tx.groupSyncOutbox.updateMany).not.toHaveBeenCalled();
    expect(tx.groupSyncOutbox.createMany).not.toHaveBeenCalled();
  });
});
