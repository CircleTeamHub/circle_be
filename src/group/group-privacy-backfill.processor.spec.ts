import { GroupPrivacyBackfillProcessor } from './group-privacy-backfill.processor';

type GroupRow = {
  groupInfo: {
    groupID: string;
    groupName: string;
    status: number;
    lookMemberInfo?: number;
    applyMemberFriend?: number;
  };
};

const group = (
  groupID: string,
  overrides: Partial<GroupRow['groupInfo']> = {},
): GroupRow => ({
  groupInfo: {
    groupID,
    groupName: groupID,
    status: 0,
    ...overrides,
  },
});

describe('GroupPrivacyBackfillProcessor', () => {
  let openim: {
    isEnabled: jest.Mock;
    listGroups: jest.Mock;
    enforceGroupMemberPrivacy: jest.Mock;
  };
  let lockAcquired: boolean;
  let prisma: { $transaction: jest.Mock };
  let processor: GroupPrivacyBackfillProcessor;

  beforeEach(() => {
    openim = {
      isEnabled: jest.fn().mockReturnValue(true),
      listGroups: jest.fn(),
      enforceGroupMemberPrivacy: jest.fn().mockResolvedValue(undefined),
    };
    lockAcquired = true;
    prisma = {
      $transaction: jest.fn(async (callback: (tx: any) => Promise<void>) =>
        callback({
          $queryRaw: jest.fn(async () => [{ acquired: lockAcquired }]),
        }),
      ),
    };
    processor = new GroupPrivacyBackfillProcessor(openim as any, prisma as any);
  });

  it('restricts a legacy group without requiring a manager to open the app', async () => {
    openim.listGroups.mockResolvedValue({
      total: 1,
      groups: [group('legacy-1')],
    });

    await processor.reconcile();

    expect(openim.enforceGroupMemberPrivacy).toHaveBeenCalledWith('legacy-1');
  });

  it('leaves already-restricted groups untouched (idempotent steady state)', async () => {
    openim.listGroups.mockResolvedValue({
      total: 2,
      groups: [
        group('restricted', { lookMemberInfo: 1, applyMemberFriend: 1 }),
        group('half-open', { lookMemberInfo: 1 }),
      ],
    });

    await processor.reconcile();

    expect(openim.enforceGroupMemberPrivacy).toHaveBeenCalledTimes(1);
    expect(openim.enforceGroupMemberPrivacy).toHaveBeenCalledWith('half-open');
  });

  it('skips dismissed groups', async () => {
    openim.listGroups.mockResolvedValue({
      total: 1,
      groups: [group('gone', { status: 2 })],
    });

    await processor.reconcile();

    expect(openim.enforceGroupMemberPrivacy).not.toHaveBeenCalled();
  });

  it('pages through the full group directory', async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      group(`page1-${index}`, { lookMemberInfo: 1, applyMemberFriend: 1 }),
    );
    openim.listGroups
      .mockResolvedValueOnce({ total: 101, groups: pageOne })
      .mockResolvedValueOnce({ total: 101, groups: [group('page2-legacy')] });

    await processor.reconcile();

    expect(openim.listGroups).toHaveBeenCalledTimes(2);
    expect(openim.listGroups).toHaveBeenNthCalledWith(2, {
      page: 2,
      limit: 100,
    });
    expect(openim.enforceGroupMemberPrivacy).toHaveBeenCalledWith(
      'page2-legacy',
    );
  });

  it('keeps going when a single group fails and retries it next run', async () => {
    openim.listGroups.mockResolvedValue({
      total: 2,
      groups: [group('flaky'), group('healthy')],
    });
    openim.enforceGroupMemberPrivacy
      .mockRejectedValueOnce(new Error('openim 502'))
      .mockResolvedValueOnce(undefined);

    await processor.reconcile();

    expect(openim.enforceGroupMemberPrivacy).toHaveBeenCalledWith('healthy');

    // 下一轮对账重扫时（标志仍缺失）会再次尝试失败过的群。
    openim.enforceGroupMemberPrivacy.mockClear();
    openim.enforceGroupMemberPrivacy.mockResolvedValue(undefined);
    await processor.reconcile();
    expect(openim.enforceGroupMemberPrivacy).toHaveBeenCalledWith('flaky');
  });

  it('does nothing when OpenIM outbound is not configured', async () => {
    openim.isEnabled.mockReturnValue(false);

    await processor.reconcile();

    expect(openim.listGroups).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('skips the round when another replica holds the advisory lock', async () => {
    lockAcquired = false;
    openim.listGroups.mockResolvedValue({
      total: 1,
      groups: [group('legacy-1')],
    });

    await processor.reconcile();

    expect(openim.listGroups).not.toHaveBeenCalled();
    expect(openim.enforceGroupMemberPrivacy).not.toHaveBeenCalled();
  });

  it('does not overlap concurrent reconcile runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    openim.listGroups.mockImplementation(async () => {
      await gate;
      return { total: 0, groups: [] };
    });

    const first = processor.reconcile();
    const second = processor.reconcile();
    release();
    await Promise.all([first, second]);

    expect(openim.listGroups).toHaveBeenCalledTimes(1);
  });
});
