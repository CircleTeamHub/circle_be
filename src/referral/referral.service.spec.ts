import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CoinService } from 'src/coin/coin.service';
import { NotificationService } from 'src/notification/notification.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { ReferralService } from './referral.service';
import { buildPendingReferralData } from './referral.rules';

const NOW = new Date('2026-08-12T12:00:00.000Z');

describe('ReferralService', () => {
  let service: ReferralService;

  const tx = {
    $queryRaw: jest.fn(),
    referral: {
      findUnique: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    friend: { findFirst: jest.fn() },
    wallet: { upsert: jest.fn(), update: jest.fn() },
    coinTransaction: { create: jest.fn() },
  };
  const prisma = {
    referral: {
      findMany: jest.fn(),
      groupBy: jest.fn(),
      aggregate: jest.fn(),
    },
    user: { findUniqueOrThrow: jest.fn() },
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const coins = { creditInTransaction: jest.fn() };
  const notifications = { createSystemNotification: jest.fn() };
  const realtime = {
    broadcastWalletBalanceChanged: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
    safeBroadcastAll: jest.fn(
      async (operations: Array<() => unknown | Promise<unknown>>) =>
        Promise.allSettled(operations.map((operation) => operation())),
    ),
  };

  const pendingReferral = (overrides: Record<string, unknown> = {}) => ({
    id: 'referral-1',
    inviterID: 'inviter-1',
    inviteeID: 'invitee-1',
    status: 'PENDING',
    inviterReward: 20,
    inviteeReward: 5,
    eligibleAt: new Date('2026-08-05T12:00:00.000Z'),
    expiresAt: new Date('2026-09-01T12:00:00.000Z'),
    inviter: { id: 'inviter-1', status: 'ACTIVE' },
    invitee: { id: 'invitee-1', status: 'ACTIVE', avatarUrl: 'avatar.jpg' },
    ...overrides,
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.referral.findMany.mockResolvedValue([{ id: 'referral-1' }]);
    tx.$queryRaw.mockResolvedValue([{ id: 'referral-1' }]);
    tx.referral.findUnique.mockResolvedValue(pendingReferral());
    tx.friend.findFirst.mockResolvedValue({ id: 'friend-1' });
    tx.referral.count.mockResolvedValue(0);
    tx.referral.update.mockResolvedValue({});
    coins.creditInTransaction.mockResolvedValue(20);
    notifications.createSystemNotification.mockResolvedValue(null);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReferralService,
        { provide: PrismaService, useValue: prisma },
        { provide: CoinService, useValue: coins },
        { provide: NotificationService, useValue: notifications },
        { provide: RealtimeService, useValue: realtime },
        { provide: ConfigService, useValue: { get: () => undefined } },
      ],
    }).compile();
    service = module.get(ReferralService);
  });

  it('snapshots reward rules when registration creates a referral', async () => {
    const data = buildPendingReferralData(
      {
        enabled: true,
        inviterReward: 20,
        inviteeReward: 5,
        qualificationDays: 7,
        expiryDays: 30,
        monthlyCap: 10,
      },
      {
        inviterId: 'inviter-1',
        inviteeId: 'invitee-1',
        createdAt: NOW,
      },
    );

    expect(data).toEqual({
      inviterID: 'inviter-1',
      inviteeID: 'invitee-1',
      status: 'PENDING',
      inviterReward: 20,
      inviteeReward: 5,
      eligibleAt: new Date('2026-08-19T12:00:00.000Z'),
      nextCheckAt: new Date('2026-08-19T12:00:00.000Z'),
      expiresAt: new Date('2026-09-11T12:00:00.000Z'),
    });
  });

  it('credits both wallets and ledger entries exactly inside the settlement transaction', async () => {
    const result = await service.processDue(NOW);

    expect(result).toEqual({ rewarded: 1, capped: 0, rejected: 0, expired: 0 });
    expect(coins.creditInTransaction).toHaveBeenNthCalledWith(
      1,
      tx,
      expect.objectContaining({
        userId: 'inviter-1',
        amount: 20,
        type: 'REFERRAL_REWARD',
        idempotencyKey: 'referral:inviter:referral-1',
      }),
    );
    expect(coins.creditInTransaction).toHaveBeenNthCalledWith(
      2,
      tx,
      expect.objectContaining({
        userId: 'invitee-1',
        amount: 5,
        type: 'REFERRAL_BONUS',
        idempotencyKey: 'referral:invitee:referral-1',
      }),
    );
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: expect.objectContaining({
        status: 'REWARDED',
        qualifiedAt: NOW,
        rewardedAt: NOW,
      }),
    });
  });

  it('keeps an incomplete invitee pending without touching either wallet', async () => {
    tx.referral.findUnique.mockResolvedValue(
      pendingReferral({
        invitee: { id: 'invitee-1', status: 'ACTIVE', avatarUrl: null },
      }),
    );

    const result = await service.processDue(NOW);

    expect(result).toEqual({ rewarded: 0, capped: 0, rejected: 0, expired: 0 });
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: { nextCheckAt: new Date('2026-08-12T18:00:00.000Z') },
    });
  });

  it('enforces the qualification delay even when a row is selected early', async () => {
    const eligibleAt = new Date('2026-08-19T12:00:00.000Z');
    tx.referral.findUnique.mockResolvedValue(pendingReferral({ eligibleAt }));

    const result = await service.processDue(NOW);

    expect(result).toEqual({
      rewarded: 0,
      capped: 0,
      rejected: 0,
      expired: 0,
    });
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: { nextCheckAt: eligibleAt },
    });
  });

  it('keeps an invite pending until the invitee accepts a non-inviter friend', async () => {
    tx.friend.findFirst.mockResolvedValue(null);

    const result = await service.processDue(NOW);

    expect(result).toEqual({
      rewarded: 0,
      capped: 0,
      rejected: 0,
      expired: 0,
    });
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.friend.findFirst).toHaveBeenCalledWith({
      where: {
        state: 'ACCEPTED',
        OR: [
          { userID: 'invitee-1', friendID: { not: 'inviter-1' } },
          { friendID: 'invitee-1', userID: { not: 'inviter-1' } },
        ],
      },
      select: { id: true },
    });
  });

  it('marks qualified referrals capped after ten rewards in the UTC month', async () => {
    tx.referral.count.mockResolvedValue(10);

    const result = await service.processDue(NOW);

    expect(result.capped).toBe(1);
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: {
        status: 'CAPPED',
        qualifiedAt: NOW,
        failureReason: 'MONTHLY_CAP_REACHED',
      },
    });
  });

  it('expires an unqualified referral without issuing rewards', async () => {
    tx.referral.findUnique.mockResolvedValue(
      pendingReferral({ expiresAt: new Date('2026-08-12T12:00:00.000Z') }),
    );

    const result = await service.processDue(NOW);

    expect(result.expired).toBe(1);
    expect(coins.creditInTransaction).not.toHaveBeenCalled();
    expect(tx.referral.update).toHaveBeenCalledWith({
      where: { id: 'referral-1' },
      data: {
        status: 'EXPIRED',
        failureReason: 'QUALIFICATION_WINDOW_EXPIRED',
      },
    });
  });
});
