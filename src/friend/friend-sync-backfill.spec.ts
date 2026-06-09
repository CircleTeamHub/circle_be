const {
  backfillFriendSyncOutbox,
  buildFriendSyncOutboxRows,
} = require('../../scripts/backfill-friend-sync-outbox');

describe('friend sync outbox backfill', () => {
  it('builds import-friend rows for accepted friendships in both directions', () => {
    expect(
      buildFriendSyncOutboxRows({
        acceptedFriendships: [{ userID: 'user-1', friendID: 'user-2' }],
        blocks: [],
      }),
    ).toEqual([
      { operation: 'IMPORT_FRIEND', userID: 'user-1', targetUserID: 'user-2' },
      { operation: 'IMPORT_FRIEND', userID: 'user-2', targetUserID: 'user-1' },
    ]);
  });

  it('builds blacklist and friendship removal rows for existing blocks', () => {
    expect(
      buildFriendSyncOutboxRows({
        acceptedFriendships: [],
        blocks: [{ blockerID: 'user-1', blockedID: 'user-2' }],
      }),
    ).toEqual([
      { operation: 'ADD_BLACKLIST', userID: 'user-1', targetUserID: 'user-2' },
      { operation: 'DELETE_FRIEND', userID: 'user-1', targetUserID: 'user-2' },
      { operation: 'DELETE_FRIEND', userID: 'user-2', targetUserID: 'user-1' },
    ]);
  });

  it('deduplicates duplicate operation/user/target rows', () => {
    expect(
      buildFriendSyncOutboxRows({
        acceptedFriendships: [
          { userID: 'user-1', friendID: 'user-2' },
          { userID: 'user-2', friendID: 'user-1' },
        ],
        blocks: [],
      }),
    ).toEqual([
      { operation: 'IMPORT_FRIEND', userID: 'user-1', targetUserID: 'user-2' },
      { operation: 'IMPORT_FRIEND', userID: 'user-2', targetUserID: 'user-1' },
    ]);
  });

  it('does not write rows in dry-run mode', async () => {
    const prisma = {
      friend: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userID: 'user-1', friendID: 'user-2' }]),
      },
      block: { findMany: jest.fn().mockResolvedValue([]) },
      friendSyncOutbox: { createMany: jest.fn() },
    };

    await expect(
      backfillFriendSyncOutbox(prisma, { dryRun: true }),
    ).resolves.toEqual({ planned: 2, created: 0, dryRun: true });
    expect(prisma.friendSyncOutbox.createMany).not.toHaveBeenCalled();
  });

  it('writes rows with skipDuplicates in apply mode', async () => {
    const prisma = {
      friend: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ userID: 'user-1', friendID: 'user-2' }]),
      },
      block: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ blockerID: 'user-1', blockedID: 'user-3' }]),
      },
      friendSyncOutbox: {
        createMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
    };

    await expect(
      backfillFriendSyncOutbox(prisma, { dryRun: false }),
    ).resolves.toEqual({ planned: 5, created: 5, dryRun: false });
    expect(prisma.friendSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        { operation: 'IMPORT_FRIEND', userID: 'user-1', targetUserID: 'user-2' },
        { operation: 'IMPORT_FRIEND', userID: 'user-2', targetUserID: 'user-1' },
        { operation: 'ADD_BLACKLIST', userID: 'user-1', targetUserID: 'user-3' },
        { operation: 'DELETE_FRIEND', userID: 'user-1', targetUserID: 'user-3' },
        { operation: 'DELETE_FRIEND', userID: 'user-3', targetUserID: 'user-1' },
      ],
      skipDuplicates: true,
    });
  });
});
