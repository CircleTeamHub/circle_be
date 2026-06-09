import { OutboxService } from './outbox.service';

describe('OutboxService', () => {
  let prisma: {
    friendSyncOutbox: {
      groupBy: jest.Mock;
      findFirst: jest.Mock;
    };
    groupSyncOutbox: {
      groupBy: jest.Mock;
      findFirst: jest.Mock;
    };
  };
  let service: OutboxService;

  beforeEach(() => {
    prisma = {
      friendSyncOutbox: {
        groupBy: jest.fn(),
        findFirst: jest.fn(),
      },
      groupSyncOutbox: {
        groupBy: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    service = new OutboxService(prisma as any);
  });

  it('returns status counts and oldest stuck timestamps for friend and group outboxes', async () => {
    const oldestFriendFailed = new Date('2026-06-08T10:00:00Z');
    const oldestGroupPending = new Date('2026-06-08T11:00:00Z');
    prisma.friendSyncOutbox.groupBy.mockResolvedValue([
      { status: 'PENDING', _count: { _all: 2 } },
      { status: 'FAILED', _count: { _all: 1 } },
    ]);
    prisma.groupSyncOutbox.groupBy.mockResolvedValue([
      { status: 'PROCESSING', _count: { _all: 3 } },
    ]);
    prisma.friendSyncOutbox.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ createdAt: oldestFriendFailed });
    prisma.groupSyncOutbox.findFirst
      .mockResolvedValueOnce({ createdAt: oldestGroupPending })
      .mockResolvedValueOnce(null);

    await expect(service.getHealth()).resolves.toEqual({
      friend: {
        pending: 2,
        processing: 0,
        failed: 1,
        oldestPendingAt: null,
        oldestFailedAt: oldestFriendFailed,
      },
      group: {
        pending: 0,
        processing: 3,
        failed: 0,
        oldestPendingAt: oldestGroupPending,
        oldestFailedAt: null,
      },
    });
  });
});
