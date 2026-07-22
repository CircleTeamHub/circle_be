import { GroupSyncOutboxProcessor } from './group-sync-outbox.processor';

describe('GroupSyncOutboxProcessor', () => {
  let transactionDepth: number;
  let prisma: {
    $transaction: jest.Mock;
    circle: { findFirst: jest.Mock; findUnique: jest.Mock };
    circleMember: { findUnique: jest.Mock };
    groupSyncOutbox: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      createMany: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };
  let memberLock: { lock: jest.Mock };
  let openim: {
    addGroupMembers: jest.Mock;
    removeGroupMember: jest.Mock;
  };
  let processor: GroupSyncOutboxProcessor;

  beforeEach(() => {
    transactionDepth = 0;
    prisma = {
      $transaction: jest.fn(async (callback) => {
        transactionDepth += 1;
        try {
          return await callback(prisma);
        } finally {
          transactionDepth -= 1;
        }
      }),
      circle: {
        findFirst: jest.fn().mockResolvedValue({ id: 'circle-1' }),
        findUnique: jest.fn().mockResolvedValue({ groupID: 'group-1' }),
      },
      circleMember: {
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
      groupSyncOutbox: {
        findMany: jest.fn(),
        createMany: jest.fn(),
        findUnique: jest.fn().mockImplementation(({ where }) => ({
          id: where.id,
          status: 'PROCESSING',
        })),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    openim = {
      addGroupMembers: jest.fn().mockResolvedValue(undefined),
      removeGroupMember: jest.fn().mockResolvedValue(undefined),
    };
    memberLock = { lock: jest.fn() };
    processor = new GroupSyncOutboxProcessor(
      prisma as any,
      openim as any,
      memberLock as any,
    );
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
    openim.addGroupMembers.mockImplementation(async () => {
      expect(transactionDepth).toBe(0);
    });

    await processor.processPending();

    expect(openim.addGroupMembers).toHaveBeenCalledWith('group-1', ['user-1']);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(memberLock.lock.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.groupSyncOutbox.updateMany.mock.invocationCallOrder[0],
    );
    expect(prisma.groupSyncOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        operation: 'ADD_MEMBER',
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

  it('requeues REMOVE when a blocked stale ADD lands after a leave', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'add-generation',
        operation: 'ADD_MEMBER',
        status: 'PENDING',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 0,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    openim.addGroupMembers.mockImplementation(async () => {
      expect(transactionDepth).toBe(0);
      prisma.groupSyncOutbox.findUnique.mockResolvedValue({
        status: 'COMPLETED',
        operation: 'ADD_MEMBER',
      });
      prisma.circleMember.findUnique.mockResolvedValue(null);
    });

    await processor.processPending();

    expect(prisma.groupSyncOutbox.updateMany).toHaveBeenLastCalledWith({
      where: {
        groupID: 'group-1',
        userID: { in: ['user-1'] },
        status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
      },
      data: {
        status: 'COMPLETED',
        processedAt: expect.any(Date),
        lockedAt: null,
        lastError: 'Superseded by desired REMOVE_MEMBER state',
      },
    });
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'REMOVE_MEMBER',
          groupID: 'group-1',
          userID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('requeues ADD when a blocked stale REMOVE lands after reactivation', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'remove-generation',
        operation: 'REMOVE_MEMBER',
        status: 'PENDING',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 0,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.circleMember.findUnique.mockResolvedValue(null);
    openim.removeGroupMember.mockImplementation(async () => {
      expect(transactionDepth).toBe(0);
      prisma.groupSyncOutbox.findUnique.mockResolvedValue({
        status: 'COMPLETED',
        operation: 'REMOVE_MEMBER',
      });
      prisma.circleMember.findUnique.mockResolvedValue({ status: 'ACTIVE' });
    });

    await processor.processPending();

    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'ADD_MEMBER',
          groupID: 'group-1',
          userID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('marks failed jobs retryable with backoff', async () => {
    prisma.circleMember.findUnique.mockResolvedValue(null);
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
    prisma.circleMember.findUnique.mockResolvedValue(null);
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

  it('applies one OpenIM add when two processors select the same job', async () => {
    const job = {
      id: 'job-1',
      operation: 'ADD_MEMBER',
      status: 'PENDING',
      groupID: 'group-1',
      userID: 'user-1',
      attempts: 0,
    };
    prisma.groupSyncOutbox.findMany.mockResolvedValue([job]);
    prisma.groupSyncOutbox.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await Promise.all([processor.processPending(), processor.processPending()]);

    expect(openim.addGroupMembers).toHaveBeenCalledTimes(1);
    expect(openim.addGroupMembers).toHaveBeenCalledWith('group-1', ['user-1']);
  });

  it('supersedes a stale ADD when the mapped circle membership is not active', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-stale-add',
        operation: 'ADD_MEMBER',
        status: 'FAILED',
        groupID: 'openim-group-1',
        userID: 'user-1',
        attempts: 2,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.circleMember.findUnique.mockResolvedValue(null);

    await processor.processPending();

    expect(prisma.circle.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [{ id: 'openim-group-1' }, { groupID: 'openim-group-1' }],
      },
      select: { id: true },
    });
    expect(memberLock.lock).toHaveBeenCalledWith(prisma, 'circle-1', [
      'user-1',
    ]);
    expect(openim.addGroupMembers).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'REMOVE_MEMBER',
          groupID: 'openim-group-1',
          userID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('supersedes a stale REMOVE when the mapped membership is active', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-stale-remove',
        operation: 'REMOVE_MEMBER',
        status: 'PENDING',
        groupID: 'group-1',
        userID: 'user-1',
        attempts: 0,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });

    await processor.processPending();

    expect(openim.removeGroupMember).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'ADD_MEMBER',
          groupID: 'group-1',
          userID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
  });

  it('does not claim a job that was superseded while waiting for its member lock', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-superseded',
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
    expect(prisma.groupSyncOutbox.findUnique).not.toHaveBeenCalled();
  });

  it('supersedes an ADD when the locked circle no longer maps to the job group', async () => {
    prisma.groupSyncOutbox.findMany.mockResolvedValue([
      {
        id: 'job-old-group',
        operation: 'ADD_MEMBER',
        status: 'PENDING',
        groupID: 'old-group',
        userID: 'user-1',
        attempts: 0,
      },
    ]);
    prisma.groupSyncOutbox.updateMany.mockResolvedValue({ count: 1 });
    prisma.circle.findUnique.mockResolvedValue({ groupID: 'new-group' });

    await processor.processPending();

    expect(memberLock.lock).toHaveBeenCalled();
    expect(openim.addGroupMembers).not.toHaveBeenCalled();
    expect(prisma.groupSyncOutbox.createMany).toHaveBeenCalledWith({
      data: [
        {
          operation: 'REMOVE_MEMBER',
          groupID: 'old-group',
          userID: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
  });
});
