import { enqueueCircleMemberSync } from 'src/circle/circle-member-sync';
import { GroupSyncOperation } from 'src/generated/prisma';
import { GroupSyncOutboxProcessor } from './group-sync-outbox.processor';

type Row = {
  id: string;
  operation: GroupSyncOperation;
  generation: number;
  processingGeneration: number | null;
  processingOperation: GroupSyncOperation | null;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  groupID: string;
  userID: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  lockedAt: Date | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

describe('GroupSyncOutboxProcessor desired-state machine', () => {
  let row: Row | null;
  let membershipActive: boolean;
  let membershipRole: 'OWNER' | 'ADMIN' | 'MEMBER';
  let transactionDepth: number;
  let transactionCount: number;
  let crashBeforeTransaction: number | null;
  let prisma: any;
  let openim: {
    addGroupMembers: jest.Mock;
    removeGroupMember: jest.Mock;
    setGroupMemberRole: jest.Mock;
  };
  let memberLock: { lock: jest.Mock };
  let processor: GroupSyncOutboxProcessor;

  const oldDate = () => new Date(Date.now() - 10 * 60 * 1000);

  const pendingRow = (operation: GroupSyncOperation = 'ADD_MEMBER'): Row => ({
    id: 'state-1',
    operation,
    generation: 1,
    processingGeneration: null,
    processingOperation: null,
    status: 'PENDING',
    groupID: 'group-1',
    userID: 'user-1',
    attempts: 0,
    lastError: null,
    nextAttemptAt: oldDate(),
    lockedAt: null,
    processedAt: null,
    createdAt: oldDate(),
    updatedAt: oldDate(),
  });

  const valuesEqual = (actual: unknown, expected: unknown): boolean => {
    if (actual instanceof Date && expected instanceof Date) {
      return actual.getTime() === expected.getTime();
    }
    if (
      expected &&
      typeof expected === 'object' &&
      'in' in (expected as Record<string, unknown>)
    ) {
      return (expected as { in: unknown[] }).in.includes(actual);
    }
    return actual === expected;
  };

  const matches = (current: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, expected]) =>
      valuesEqual(current[key as keyof Row], expected),
    );

  const applyData = (current: Row, data: Record<string, any>): void => {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (value && typeof value === 'object' && 'increment' in value) {
        (current as any)[key] += value.increment;
      } else {
        (current as any)[key] = value;
      }
    }
    current.updatedAt = new Date();
  };

  beforeEach(() => {
    row = pendingRow();
    membershipActive = true;
    membershipRole = 'MEMBER';
    transactionDepth = 0;
    transactionCount = 0;
    crashBeforeTransaction = null;

    const groupSyncOutbox = {
      findMany: jest.fn(async () => {
        if (!row) return [];
        const normalReady =
          row.processingGeneration === null &&
          ['PENDING', 'FAILED'].includes(row.status) &&
          row.nextAttemptAt <= new Date();
        const stale =
          row.processingGeneration !== null &&
          row.processingOperation !== null &&
          row.lockedAt !== null &&
          row.lockedAt < new Date(Date.now() - 5 * 60 * 1000);
        return normalReady || stale ? [{ ...row }] : [];
      }),
      findUnique: jest.fn(async ({ where }: any) =>
        row?.id === where.id ? { ...row } : null,
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!row || !matches(row, where)) return { count: 0 };
        applyData(row, data);
        return { count: 1 };
      }),
      createMany: jest.fn(async ({ data }: any) => {
        if (row) return { count: 0 };
        row = {
          ...pendingRow(data[0].operation),
          ...data[0],
        };
        return { count: 1 };
      }),
    };

    prisma = {
      $transaction: jest.fn(async (callback: (tx: any) => Promise<any>) => {
        transactionCount += 1;
        if (crashBeforeTransaction === transactionCount) {
          throw new Error('simulated process death before finalize');
        }
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
        findUnique: jest.fn(async () =>
          membershipActive ? { status: 'ACTIVE', role: membershipRole } : null,
        ),
      },
      groupSyncOutbox,
    };
    openim = {
      addGroupMembers: jest.fn().mockResolvedValue(undefined),
      removeGroupMember: jest.fn().mockResolvedValue(undefined),
      setGroupMemberRole: jest.fn().mockResolvedValue(undefined),
    };
    memberLock = { lock: jest.fn() };
    processor = new GroupSyncOutboxProcessor(
      prisma,
      openim as any,
      memberLock as any,
    );
  });

  it('claims and completes the current desired generation outside transactions', async () => {
    openim.addGroupMembers.mockImplementation(async () => {
      expect(transactionDepth).toBe(0);
    });

    await processor.processPending();

    expect(openim.addGroupMembers).toHaveBeenCalledWith('group-1', ['user-1']);
    expect(row).toMatchObject({
      operation: 'ADD_MEMBER',
      generation: 1,
      processingGeneration: null,
      processingOperation: null,
      status: 'COMPLETED',
      lockedAt: null,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('preserves a newer REMOVE while ADD is in flight, then advances to it', async () => {
    let releaseAdd!: () => void;
    const addBlocked = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    let markStarted!: () => void;
    const addStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    openim.addGroupMembers.mockImplementation(async () => {
      markStarted();
      await addBlocked;
    });

    const adding = processor.processPending();
    await addStarted;
    membershipActive = false;
    await enqueueCircleMemberSync(prisma, 'REMOVE_MEMBER', 'group-1', [
      'user-1',
    ]);

    expect(row).toMatchObject({
      operation: 'REMOVE_MEMBER',
      generation: 2,
      processingGeneration: 1,
      processingOperation: 'ADD_MEMBER',
      status: 'PENDING',
    });

    releaseAdd();
    await adding;
    expect(row).toMatchObject({
      operation: 'REMOVE_MEMBER',
      generation: 2,
      processingGeneration: null,
      processingOperation: null,
      status: 'PENDING',
    });

    await processor.processPending();

    expect(openim.removeGroupMember).toHaveBeenCalledWith('group-1', 'user-1');
    expect(row).toMatchObject({
      operation: 'REMOVE_MEMBER',
      generation: 2,
      status: 'COMPLETED',
    });
  });

  it('replays crashed ADD before applying the newer REMOVE', async () => {
    crashBeforeTransaction = 2;
    await expect(processor.processPending()).rejects.toThrow(
      'simulated process death',
    );
    expect(row).toMatchObject({
      processingGeneration: 1,
      processingOperation: 'ADD_MEMBER',
      status: 'PROCESSING',
    });

    membershipActive = false;
    await enqueueCircleMemberSync(prisma, 'REMOVE_MEMBER', 'group-1', [
      'user-1',
    ]);
    row!.lockedAt = oldDate();
    crashBeforeTransaction = null;

    await processor.processPending();
    expect(openim.addGroupMembers).toHaveBeenCalledTimes(2);
    expect(row).toMatchObject({
      operation: 'REMOVE_MEMBER',
      generation: 2,
      processingGeneration: null,
      status: 'PENDING',
    });

    await processor.processPending();
    expect(openim.removeGroupMember).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({
      operation: 'REMOVE_MEMBER',
      status: 'COMPLETED',
    });
  });

  it('replays crashed REMOVE before applying the newer ADD', async () => {
    row = pendingRow('REMOVE_MEMBER');
    membershipActive = false;
    crashBeforeTransaction = 2;
    await expect(processor.processPending()).rejects.toThrow(
      'simulated process death',
    );

    membershipActive = true;
    await enqueueCircleMemberSync(prisma, 'ADD_MEMBER', 'group-1', ['user-1']);
    row!.lockedAt = oldDate();
    crashBeforeTransaction = null;

    await processor.processPending();
    expect(openim.removeGroupMember).toHaveBeenCalledTimes(2);
    expect(row).toMatchObject({
      operation: 'ADD_MEMBER',
      generation: 2,
      processingGeneration: null,
      status: 'PENDING',
    });

    await processor.processPending();
    expect(openim.addGroupMembers).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ operation: 'ADD_MEMBER', status: 'COMPLETED' });
  });

  it('allows only one worker to reclaim the same stale processing lease', async () => {
    row = {
      ...pendingRow(),
      status: 'PROCESSING',
      processingGeneration: 1,
      processingOperation: 'ADD_MEMBER',
      lockedAt: oldDate(),
    };
    let releaseAdd!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    let started = 0;
    openim.addGroupMembers.mockImplementation(async () => {
      started += 1;
      await blocked;
    });

    const workers = [processor.processPending(), processor.processPending()];
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toBe(1);
    releaseAdd();
    await Promise.all(workers);

    expect(openim.addGroupMembers).toHaveBeenCalledTimes(1);
    const staleClaims = prisma.groupSyncOutbox.updateMany.mock.calls.filter(
      ([call]: any[]) =>
        call.where.processingGeneration === 1 &&
        Object.keys(call.data).length === 1 &&
        call.data.lockedAt instanceof Date,
    );
    expect(staleClaims).toHaveLength(2);
    expect(staleClaims[0][0].where).toEqual(
      expect.objectContaining({
        processingGeneration: 1,
        processingOperation: 'ADD_MEMBER',
        lockedAt: expect.any(Date),
      }),
    );
  });

  it('allows only one normal claim for the same desired generation', async () => {
    await Promise.all([processor.processPending(), processor.processPending()]);

    expect(openim.addGroupMembers).toHaveBeenCalledTimes(1);
  });

  it('clears the processing marker and schedules a retry on network failure', async () => {
    openim.addGroupMembers.mockRejectedValue(new Error('openim down'));

    await processor.processPending();

    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'openim down',
      processingGeneration: null,
      processingOperation: null,
      lockedAt: null,
    });
  });

  // review P1：角色变更先落库，由 outbox 把 DB 真值推到 OpenIM ——
  // ADD_MEMBER 的外部效果必须同时收敛角色，DB 写失败/外呼失败都能最终一致。
  it('pushes the DB role to OpenIM as part of ADD_MEMBER convergence', async () => {
    membershipRole = 'ADMIN';

    await processor.processPending();

    expect(openim.setGroupMemberRole).toHaveBeenCalledWith(
      'group-1',
      'user-1',
      60,
    );
    expect(row).toMatchObject({ status: 'COMPLETED' });
  });

  it('still converges the role when the member already exists in OpenIM', async () => {
    membershipRole = 'ADMIN';
    openim.addGroupMembers.mockRejectedValue(
      new Error('group member repeated add'),
    );

    await processor.processPending();

    expect(openim.setGroupMemberRole).toHaveBeenCalledWith(
      'group-1',
      'user-1',
      60,
    );
    expect(row).toMatchObject({ status: 'COMPLETED' });
  });

  it('never rewrites the owner role level from the sync path', async () => {
    membershipRole = 'OWNER';

    await processor.processPending();

    expect(openim.setGroupMemberRole).not.toHaveBeenCalled();
    expect(row).toMatchObject({ status: 'COMPLETED' });
  });

  it('retries when the role push fails after a successful add', async () => {
    membershipRole = 'ADMIN';
    openim.setGroupMemberRole.mockRejectedValue(new Error('openim down'));

    await processor.processPending();

    expect(row).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: 'openim down',
    });
  });
});
