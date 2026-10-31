import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { CreditService } from './credit.service';

describe('CreditService', () => {
  const tx = {
    $queryRaw: jest.fn(),
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    creditEvent: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  const prisma = {
    creditEvent: {
      findMany: jest.fn(),
    },
  };
  const realtimeService = {
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(),
    safeBroadcastAll: jest.fn((fns: Array<() => void | Promise<void>>) =>
      Promise.allSettled(fns.map((fn) => fn())),
    ),
  };
  let service: CreditService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CreditService(
      prisma as unknown as PrismaService,
      realtimeService as unknown as RealtimeService,
    );
  });

  it('applies a credit delta, clamps score, and writes an event', async () => {
    tx.creditEvent.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([{ creditScore: 3 }]);
    tx.user.update.mockResolvedValue({ id: 'user-1', creditScore: 0 });
    tx.creditEvent.create.mockResolvedValue({
      id: 'event-1',
      scoreBefore: 3,
      scoreAfter: 0,
    });

    await expect(
      service.applyDeltaInTransaction(tx as never, {
        userId: 'user-1',
        delta: -5,
        reason: 'FRIEND_REPORT',
        sourceType: 'FRIEND_REPORT',
        sourceId: 'report-1',
        actorId: 'reporter-1',
        idempotencyKey: 'friend-report:report-1',
      }),
    ).resolves.toEqual({
      eventId: 'event-1',
      scoreBefore: 3,
      scoreAfter: 0,
    });

    // The balance must be read under a row lock (SELECT ... FOR UPDATE) so
    // concurrent deltas on the same user cannot lose an update.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { creditScore: 0 },
      select: { id: true, creditScore: true },
    });
    expect(tx.creditEvent.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-1',
        delta: -5,
        scoreBefore: 3,
        scoreAfter: 0,
        reason: 'FRIEND_REPORT',
        sourceType: 'FRIEND_REPORT',
        sourceID: 'report-1',
        actorID: 'reporter-1',
        idempotencyKey: 'friend-report:report-1',
        metadata: {},
      },
      select: { id: true, scoreBefore: true, scoreAfter: true },
    });
  });

  it('invalidates and broadcasts the profile summary after a score change', async () => {
    await service.broadcastCreditProfileChanged('user-1');

    expect(
      realtimeService.invalidateUserProfileSummaryCache,
    ).toHaveBeenCalledWith('user-1');
    expect(realtimeService.broadcastUserProfileSummary).toHaveBeenCalledWith(
      'user-1',
    );
  });

  it('returns an existing event without applying the same idempotency key twice', async () => {
    tx.creditEvent.findUnique.mockResolvedValue({
      id: 'event-1',
      scoreBefore: 80,
      scoreAfter: 75,
    });

    await expect(
      service.applyDeltaInTransaction(tx as never, {
        userId: 'user-1',
        delta: -5,
        reason: 'FRIEND_REPORT',
        sourceType: 'FRIEND_REPORT',
        sourceId: 'report-1',
        actorId: 'reporter-1',
        idempotencyKey: 'friend-report:report-1',
      }),
    ).resolves.toEqual({
      eventId: 'event-1',
      scoreBefore: 80,
      scoreAfter: 75,
    });

    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.creditEvent.create).not.toHaveBeenCalled();
  });

  describe('getRecentEvents', () => {
    it("lists only the caller's latest events, newest first, capped at 50", async () => {
      prisma.creditEvent.findMany.mockResolvedValue([]);

      await service.getRecentEvents('user-1');

      expect(prisma.creditEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userID: 'user-1' },
          orderBy: { createdAt: 'desc' },
          take: 50,
        }),
      );
    });

    // 被举报人能看到自己的扣分记录，但不能拿到审核管理员或举报单 id。
    it('never selects the actor, source or idempotency key', async () => {
      prisma.creditEvent.findMany.mockResolvedValue([]);

      await service.getRecentEvents('user-1');

      const [{ select }] = prisma.creditEvent.findMany.mock.calls[0] as [
        { select: Record<string, boolean> },
      ];
      // toEqual 要求键完全一致：多选一列（如 actorID）这里就会红。
      expect(select).toEqual({
        id: true,
        delta: true,
        scoreAfter: true,
        reason: true,
        metadata: true,
        createdAt: true,
      });
    });

    it('surfaces the report category and drops the rest of metadata', async () => {
      const createdAt = new Date('2026-10-30T08:00:00.000Z');
      prisma.creditEvent.findMany.mockResolvedValue([
        {
          id: 'event-2',
          delta: -5,
          scoreAfter: 95,
          reason: 'FRIEND_REPORT',
          metadata: { category: 'harassment', internal: 'x' },
          createdAt,
        },
        {
          id: 'event-1',
          delta: 3,
          scoreAfter: 100,
          reason: 'SYSTEM',
          metadata: [],
          createdAt,
        },
      ]);

      await expect(service.getRecentEvents('user-1')).resolves.toEqual([
        {
          id: 'event-2',
          delta: -5,
          scoreAfter: 95,
          reason: 'FRIEND_REPORT',
          category: 'harassment',
          createdAt,
        },
        {
          id: 'event-1',
          delta: 3,
          scoreAfter: 100,
          reason: 'SYSTEM',
          category: null,
          createdAt,
        },
      ]);
    });
  });
});
