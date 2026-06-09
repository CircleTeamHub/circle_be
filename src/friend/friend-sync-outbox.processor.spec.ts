import { FriendSyncOutboxProcessor } from './friend-sync-outbox.processor';

describe('FriendSyncOutboxProcessor', () => {
  let prisma: {
    friendSyncOutbox: {
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let openim: {
    addBlacklist: jest.Mock;
    deleteFriend: jest.Mock;
    importFriends: jest.Mock;
    removeBlacklist: jest.Mock;
  };
  let processor: FriendSyncOutboxProcessor;

  beforeEach(() => {
    prisma = {
      friendSyncOutbox: {
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    openim = {
      addBlacklist: jest.fn().mockResolvedValue(undefined),
      deleteFriend: jest.fn().mockResolvedValue(undefined),
      importFriends: jest.fn().mockResolvedValue(undefined),
      removeBlacklist: jest.fn().mockResolvedValue(undefined),
    };
    processor = new FriendSyncOutboxProcessor(prisma as any, openim as any);
  });

  it('processes pending import-friend sync jobs and marks them completed', async () => {
    prisma.friendSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'IMPORT_FRIEND',
        status: 'PENDING',
        userID: 'user-1',
        targetUserID: 'user-2',
        attempts: 0,
      },
    ]);
    prisma.friendSyncOutbox.updateMany.mockResolvedValue({ count: 1 });

    await processor.processPending();

    expect(openim.importFriends).toHaveBeenCalledWith('user-1', ['user-2']);
    expect(prisma.friendSyncOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lastError: null,
        lockedAt: null,
      },
    });
  });

  it('marks failed jobs retryable with backoff', async () => {
    prisma.friendSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'DELETE_FRIEND',
        status: 'FAILED',
        userID: 'user-1',
        targetUserID: 'user-2',
        attempts: 2,
      },
    ]);
    prisma.friendSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    openim.deleteFriend.mockRejectedValue(new Error('openim down'));

    await processor.processPending();

    expect(openim.deleteFriend).toHaveBeenCalledWith('user-1', 'user-2');
    expect(prisma.friendSyncOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'FAILED',
        attempts: { increment: 1 },
        lastError: 'openim down',
        nextAttemptAt: expect.any(Date),
        lockedAt: null,
      },
    });
  });

  it('marks duplicate import-friend OpenIM errors as completed', async () => {
    prisma.friendSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'IMPORT_FRIEND',
        status: 'PENDING',
        userID: 'user-1',
        targetUserID: 'user-2',
        attempts: 1,
      },
    ]);
    prisma.friendSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    openim.importFriends.mockRejectedValue(
      new Error('OpenIM error: ArgsError (friend already exist)'),
    );

    await processor.processPending();

    expect(prisma.friendSyncOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lastError: null,
        lockedAt: null,
      },
    });
  });

  it('marks missing delete-friend OpenIM errors as completed', async () => {
    prisma.friendSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'DELETE_FRIEND',
        status: 'FAILED',
        userID: 'user-1',
        targetUserID: 'user-2',
        attempts: 1,
      },
    ]);
    prisma.friendSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    openim.deleteFriend.mockRejectedValue(
      new Error('OpenIM error: RecordNotFoundError'),
    );

    await processor.processPending();

    expect(prisma.friendSyncOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lastError: null,
        lockedAt: null,
      },
    });
  });

  it('dispatches blacklist operations', async () => {
    prisma.friendSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'ADD_BLACKLIST',
        status: 'PENDING',
        userID: 'user-1',
        targetUserID: 'user-2',
        attempts: 0,
      },
      {
        id: 'job-2',
        operation: 'REMOVE_BLACKLIST',
        status: 'PENDING',
        userID: 'user-1',
        targetUserID: 'user-2',
        attempts: 0,
      },
    ]);
    prisma.friendSyncOutbox.updateMany.mockResolvedValue({ count: 1 });

    await processor.processPending();

    expect(openim.addBlacklist).toHaveBeenCalledWith('user-1', 'user-2');
    expect(openim.removeBlacklist).toHaveBeenCalledWith('user-1', 'user-2');
  });

  it('does not process a job when another worker has already claimed it', async () => {
    prisma.friendSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'IMPORT_FRIEND',
        status: 'PENDING',
        userID: 'user-1',
        targetUserID: 'user-2',
        attempts: 0,
      },
    ]);
    prisma.friendSyncOutbox.updateMany.mockResolvedValue({ count: 0 });

    await processor.processPending();

    expect(openim.importFriends).not.toHaveBeenCalled();
    expect(prisma.friendSyncOutbox.update).not.toHaveBeenCalled();
  });
});
