import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { CreditPolicyService } from './credit-policy.service';
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
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const realtimeService = {
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(),
    safeBroadcastAll: jest.fn((fns: Array<() => void | Promise<void>>) =>
      Promise.allSettled(fns.map((fn) => fn())),
    ),
  };
  const creditPolicyService = {
    invalidateUserPolicyCache: jest.fn(),
  };
  let service: CreditService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CreditService(
      prisma as unknown as PrismaService,
      realtimeService as unknown as RealtimeService,
      creditPolicyService as unknown as CreditPolicyService,
    );
  });

  it('applies a credit delta, clamps score, writes an event, and broadcasts profile summary', async () => {
    tx.creditEvent.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([{ creditScore: 3 }]);
    tx.user.update.mockResolvedValue({ id: 'user-1', creditScore: 0 });
    tx.creditEvent.create.mockResolvedValue({
      id: 'event-1',
      scoreBefore: 3,
      scoreAfter: 0,
    });

    await expect(
      service.applyDelta({
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
    expect(creditPolicyService.invalidateUserPolicyCache).toHaveBeenCalledWith(
      'user-1',
    );
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
      service.applyDelta({
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

  describe('revertEvent', () => {
    it('posts a compensating entry, stamps revertedAt, and broadcasts', async () => {
      tx.creditEvent.findUnique
        // 1st call: locate the event to revert
        .mockResolvedValueOnce({
          id: 'event-1',
          userID: 'user-1',
          delta: -5,
          revertedAt: null,
        })
        // 2nd call: idempotency lookup inside applyDeltaInTransaction
        .mockResolvedValueOnce(null);
      tx.$queryRaw.mockResolvedValue([{ creditScore: 70 }]);
      tx.user.update.mockResolvedValue({ id: 'user-1', creditScore: 75 });
      tx.creditEvent.create.mockResolvedValue({
        id: 'reversal-1',
        scoreBefore: 70,
        scoreAfter: 75,
      });
      tx.creditEvent.update.mockResolvedValue({ id: 'event-1' });

      await expect(
        service.revertEvent('event-1', { actorId: 'admin-1' }),
      ).resolves.toEqual({
        reverted: true,
        userId: 'user-1',
        reversalEventId: 'reversal-1',
        scoreBefore: 70,
        scoreAfter: 75,
      });

      // Compensating entry is the opposite delta under its own source type.
      expect(tx.creditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userID: 'user-1',
            delta: 5,
            reason: 'REVERT',
            sourceType: 'CREDIT_REVERT',
            sourceID: 'event-1',
            idempotencyKey: 'revert:event-1',
          }),
        }),
      );
      // Original is voided, not deleted.
      expect(tx.creditEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'event-1' },
          data: { revertedAt: expect.any(Date) },
        }),
      );
      expect(realtimeService.broadcastUserProfileSummary).toHaveBeenCalledWith(
        'user-1',
      );
    });

    it('is a no-op for an already-reverted event', async () => {
      tx.creditEvent.findUnique.mockResolvedValueOnce({
        id: 'event-1',
        userID: 'user-1',
        delta: -5,
        revertedAt: new Date(),
      });

      await expect(service.revertEvent('event-1')).resolves.toEqual({
        reverted: false,
      });

      expect(tx.creditEvent.create).not.toHaveBeenCalled();
      expect(tx.creditEvent.update).not.toHaveBeenCalled();
      expect(
        realtimeService.broadcastUserProfileSummary,
      ).not.toHaveBeenCalled();
    });

    it('is a no-op for a missing event', async () => {
      tx.creditEvent.findUnique.mockResolvedValueOnce(null);

      await expect(service.revertEvent('missing')).resolves.toEqual({
        reverted: false,
      });
      expect(tx.creditEvent.create).not.toHaveBeenCalled();
    });

    it('refuses to revert a reversal entry (no re-applying the original delta)', async () => {
      tx.creditEvent.findUnique.mockResolvedValueOnce({
        id: 'reversal-1',
        userID: 'user-1',
        delta: 5,
        revertedAt: null,
        sourceType: 'CREDIT_REVERT',
      });

      await expect(service.revertEvent('reversal-1')).resolves.toEqual({
        reverted: false,
      });

      expect(tx.creditEvent.create).not.toHaveBeenCalled();
      expect(tx.creditEvent.update).not.toHaveBeenCalled();
    });
  });

  describe('revertBySource', () => {
    it('reverts the most recent un-reverted event for a source', async () => {
      tx.creditEvent.findFirst.mockResolvedValueOnce({ id: 'event-1' });
      tx.creditEvent.findUnique
        .mockResolvedValueOnce({
          id: 'event-1',
          userID: 'user-1',
          delta: -5,
          revertedAt: null,
        })
        .mockResolvedValueOnce(null);
      tx.$queryRaw.mockResolvedValue([{ creditScore: 70 }]);
      tx.user.update.mockResolvedValue({ id: 'user-1', creditScore: 75 });
      tx.creditEvent.create.mockResolvedValue({
        id: 'reversal-1',
        scoreBefore: 70,
        scoreAfter: 75,
      });
      tx.creditEvent.update.mockResolvedValue({ id: 'event-1' });

      await expect(
        service.revertBySource('FRIEND_REPORT', 'report-1'),
      ).resolves.toEqual({
        reverted: true,
        userId: 'user-1',
        reversalEventId: 'reversal-1',
        scoreBefore: 70,
        scoreAfter: 75,
      });

      expect(tx.creditEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sourceType: 'FRIEND_REPORT',
            sourceID: 'report-1',
            revertedAt: null,
          },
        }),
      );
    });

    it('returns reverted:false when the source has no un-reverted event', async () => {
      tx.creditEvent.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.revertBySource('FRIEND_REPORT', 'report-1'),
      ).resolves.toEqual({ reverted: false });

      expect(tx.creditEvent.create).not.toHaveBeenCalled();
    });
  });
});
