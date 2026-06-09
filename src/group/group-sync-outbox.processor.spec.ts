import { GroupSyncOutboxProcessor } from './group-sync-outbox.processor';

describe('GroupSyncOutboxProcessor', () => {
  let prisma: {
    groupSyncOutbox: {
      findMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let openim: {
    addGroupMembers: jest.Mock;
    removeGroupMember: jest.Mock;
  };
  let processor: GroupSyncOutboxProcessor;

  beforeEach(() => {
    prisma = {
      groupSyncOutbox: {
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    openim = {
      addGroupMembers: jest.fn().mockResolvedValue(undefined),
      removeGroupMember: jest.fn().mockResolvedValue(undefined),
    };
    processor = new GroupSyncOutboxProcessor(prisma as any, openim as any);
  });

  it('processes pending add-member sync jobs and marks them completed', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'ADD_MEMBER',
        status: 'PENDING',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 0,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });

    await processor.processPending();

    expect(openim.addGroupMembers).toHaveBeenCalledWith('group-1', ['user-1']);
    expect(prisma.groupSyncOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: 'PENDING',
      },
      data: {
        status: 'PROCESSING',
        lockedAt: expect.any(Date),
      },
    });
    expect(prisma.groupSyncOutbox.update).toHaveBeenCalledWith({
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
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'REMOVE_MEMBER',
        status: 'FAILED',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 2,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    openim.removeGroupMember.mockRejectedValue(new Error('openim down'));

    await processor.processPending();

    expect(openim.removeGroupMember).toHaveBeenCalledWith('group-1', 'user-1');
    expect(prisma.groupSyncOutbox.update).toHaveBeenCalledWith({
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

  it('marks duplicate add-member OpenIM errors as completed', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'ADD_MEMBER',
        status: 'PENDING',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 1,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    openim.addGroupMembers.mockRejectedValue(
      new Error('OpenIM error: ArgsError (group member repeated)'),
    );

    await processor.processPending();

    expect(prisma.groupSyncOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lastError: null,
        lockedAt: null,
      },
    });
  });

  it('marks missing remove-member OpenIM errors as completed', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'REMOVE_MEMBER',
        status: 'FAILED',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 1,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    openim.removeGroupMember.mockRejectedValue(
      new Error('OpenIM error: RecordNotFoundError (not group member)'),
    );

    await processor.processPending();

    expect(prisma.groupSyncOutbox.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lastError: null,
        lockedAt: null,
      },
    });
  });

  it('does not process a job when another worker has already claimed it', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-1',
        operation: 'ADD_MEMBER',
        status: 'PENDING',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 0,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 0 });

    await processor.processPending();

    expect(openim.addGroupMembers).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.update).not.toHaveBeenCalled();
  });
});
