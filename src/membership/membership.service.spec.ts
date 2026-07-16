import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { MembershipService } from './membership.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationService } from 'src/notification/notification.service';

describe('MembershipService', () => {
  let service: MembershipService;

  const tx = {
    user: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    wallet: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    coinTransaction: {
      create: jest.fn(),
    },
  };

  const prisma = {
    $transaction: jest.fn(
      async (
        callback: (transaction: typeof tx) => Promise<unknown>,
      ): Promise<unknown> => callback(tx),
    ),
  };

  const realtimeService = {
    broadcastMembershipStatus: jest.fn(),
    broadcastWalletBalanceChanged: jest.fn(),
    broadcastSystemNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserHotCache: jest.fn(() => Promise.resolve()),
    safeBroadcastAll: jest.fn((fns: Array<() => void | Promise<void>>) =>
      Promise.allSettled(fns.map((fn) => fn())),
    ),
  };

  const notificationService = {
    createSystemNotification: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembershipService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    service = module.get<MembershipService>(MembershipService);
  });

  it('returns VIP1 to VIP5 plans priced in points', () => {
    const plans = service.getPlans();

    expect(plans).toHaveLength(5);
    expect(plans.map((plan) => plan.level)).toEqual([1, 2, 3, 4, 5]);
    expect(plans.map((plan) => plan.price)).toEqual([
      780, 1280, 2100, 4600, 9100,
    ]);
    expect(JSON.stringify(plans)).not.toContain('帮积分');
  });

  it('deducts points and upgrades the user VIP level atomically', async () => {
    tx.user.findUnique.mockResolvedValue({ id: 'user-1', vipLevel: 2 });
    tx.wallet.upsert.mockResolvedValue({
      id: 'wallet-1',
      userID: 'user-1',
      balance: 3000,
      updatedAt: new Date('2026-04-22T12:00:00.000Z'),
    });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({
      id: 'wallet-1',
      userID: 'user-1',
      balance: 900,
      updatedAt: new Date('2026-04-22T12:01:00.000Z'),
    });
    tx.user.updateMany.mockResolvedValue({ count: 1 });
    tx.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      vipLevel: 3,
      creditScore: 100,
    });
    tx.coinTransaction.create.mockResolvedValue({
      id: 'tx-1',
      userID: 'user-1',
      type: 'PURCHASE',
      amount: -2100,
      balance: 900,
      note: '兑换 VIP3',
      relatedID: null,
      createdAt: new Date('2026-04-22T12:01:00.000Z'),
    });

    const result = await service.upgrade('user-1', 3);

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', balance: { gte: 2100 } },
      data: { balance: { decrement: 2100 } },
    });
    // Gated on the level that was read, so a concurrent upgrade cannot be
    // overwritten by this one.
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', vipLevel: 2 },
      data: { vipLevel: 3 },
    });
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-1',
        type: 'PURCHASE',
        amount: -2100,
        balance: 900,
        note: '兑换 VIP3',
      },
    });
    expect(notificationService.createSystemNotification).toHaveBeenCalledWith(
      'user-1',
      'user-1',
      '已成功兑换 VIP3',
    );
    expect(realtimeService.broadcastMembershipStatus).toHaveBeenCalledWith(
      'user-1',
    );
    expect(realtimeService.invalidateUserHotCache).toHaveBeenCalledWith(
      'user-1',
    );
    // Hot cache must be invalidated BEFORE the status broadcast, so the
    // broadcast (and the client refetch it triggers) reads fresh data.
    expect(
      realtimeService.invalidateUserHotCache.mock.invocationCallOrder[0],
    ).toBeLessThan(
      realtimeService.broadcastMembershipStatus.mock.invocationCallOrder[0],
    );
    expect(realtimeService.broadcastWalletBalanceChanged).toHaveBeenCalledWith(
      'user-1',
      {
        reason: 'PURCHASE',
        delta: -2100,
      },
    );
    expect(
      realtimeService.broadcastSystemNotificationCreated,
    ).toHaveBeenCalledWith('user-1', '已成功兑换 VIP3');
    expect(
      realtimeService.broadcastSystemNotificationUnread,
    ).toHaveBeenCalledWith('user-1');
    expect(realtimeService.broadcastUserProfileSummary).toHaveBeenCalledWith(
      'user-1',
    );
    expect(result.user.vipLevel).toBe(3);
    expect(result.wallet.balance).toBe(900);
  });

  it('rejects upgrading to the current or lower VIP level', async () => {
    tx.user.findUnique.mockResolvedValue({ id: 'user-1', vipLevel: 5 });

    await expect(service.upgrade('user-1', 5)).rejects.toThrow(
      BadRequestException,
    );
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  // Models the two rows `upgrade()` touches the way Postgres behaves under
  // READ COMMITTED: a conditional `updateMany` re-evaluates its predicate
  // against current state at write time, and a throw rolls back only that
  // transaction's own writes.
  const createRaceHarness = (initial: {
    vipLevel: number;
    balance: number;
  }) => {
    const row = { ...initial };

    // Holds each caller at its read until both have arrived, pinning the
    // interleaving where both observe the same pre-upgrade vipLevel.
    let arrived = 0;
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = async (): Promise<void> => {
      arrived += 1;
      if (arrived === 2) {
        release();
      }
      await bothArrived;
    };

    const runTransaction = async (
      callback: (transaction: any) => Promise<unknown>,
    ): Promise<unknown> => {
      const undo: Array<() => void> = [];
      const setLevel = (next: number) => {
        const previous = row.vipLevel;
        row.vipLevel = next;
        undo.push(() => {
          row.vipLevel = previous;
        });
      };

      const transaction = {
        user: {
          findUnique: async () => {
            await barrier();
            return { id: 'user-1', vipLevel: row.vipLevel };
          },
          // Unconditional write: last writer wins, whatever it read.
          update: async ({ data }: { data: { vipLevel: number } }) => {
            setLevel(data.vipLevel);
            return { id: 'user-1', vipLevel: row.vipLevel, creditScore: 100 };
          },
          // Compare-and-set: only matches while the level is still the one
          // the caller read.
          updateMany: async ({
            where,
            data,
          }: {
            where: { vipLevel?: number };
            data: { vipLevel: number };
          }) => {
            if (where.vipLevel !== row.vipLevel) {
              return { count: 0 };
            }
            setLevel(data.vipLevel);
            return { count: 1 };
          },
          findUniqueOrThrow: async () => ({
            id: 'user-1',
            vipLevel: row.vipLevel,
            creditScore: 100,
          }),
        },
        wallet: {
          upsert: async () => ({ userID: 'user-1', balance: row.balance }),
          updateMany: async ({
            where,
            data,
          }: {
            where: { balance: { gte: number } };
            data: { balance: { decrement: number } };
          }) => {
            if (row.balance < where.balance.gte) {
              return { count: 0 };
            }
            const amount = data.balance.decrement;
            row.balance -= amount;
            undo.push(() => {
              row.balance += amount;
            });
            return { count: 1 };
          },
          findUniqueOrThrow: async () => ({
            userID: 'user-1',
            balance: row.balance,
          }),
        },
        coinTransaction: { create: async () => ({ id: 'coin-tx-1' }) },
      };

      try {
        return await callback(transaction);
      } catch (error) {
        // Roll back only this transaction's own writes, newest first.
        [...undo].reverse().forEach((rollback) => rollback());
        throw error;
      }
    };

    return { row, runTransaction };
  };

  it('charges once when two upgrades race on the same vipLevel', async () => {
    const harness = createRaceHarness({ vipLevel: 0, balance: 1560 });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembershipService,
        {
          provide: PrismaService,
          useValue: { $transaction: harness.runTransaction },
        },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();
    const racingService = module.get<MembershipService>(MembershipService);

    const results = await Promise.allSettled([
      racingService.upgrade('user-1', 1),
      racingService.upgrade('user-1', 1),
    ]);

    // VIP1 costs 780 and the wallet held exactly two of them. One upgrade wins;
    // the other must be rejected and rolled back, leaving a single charge.
    expect(harness.row.balance).toBe(780);
    expect(harness.row.vipLevel).toBe(1);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
  });
});
