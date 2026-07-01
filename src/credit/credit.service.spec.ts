import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { CreditPolicyService } from './credit-policy.service';
import { CreditService } from './credit.service';

describe('CreditService', () => {
  const tx = {
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
    tx.user.findUnique.mockResolvedValue({ id: 'user-1', creditScore: 3 });
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

    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.creditEvent.create).not.toHaveBeenCalled();
  });
});
