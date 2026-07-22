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
    // The level is claimed with a conditional write, not a blind one, so a
    // concurrent upgrade to the same level cannot also win.
    expect(tx.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', vipLevel: { lt: 3 } },
      data: { vipLevel: 3 },
    });
    // The claim must precede the debit: a loser that has already moved money
    // would leave the user charged for a level it never got.
    expect(tx.user.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      tx.wallet.updateMany.mock.invocationCallOrder[0],
    );
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-1',
        type: 'PURCHASE',
        amount: -2100,
        balance: 900,
        note: '兑换 VIP3',
        idempotencyKey: null,
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
});

// Two concurrent upgrades to the same level must charge the user once, not
// twice. The `level <= currentUser.vipLevel` guard only makes *sequential*
// replay safe: it reads a snapshot, so two overlapping transactions can both
// read the old level, both pass the guard, and both debit the wallet.
//
// Reproduced against a real Postgres 16 before this test was written: two
// concurrent `upgrade(user, 1)` calls both succeeded and took 1560 points for
// a single 780-point VIP1 upgrade.
describe('MembershipService concurrent upgrade', () => {
  const VIP1_PRICE = 780;

  // Releases only once `parties` callers have arrived, which pins the
  // interleaving that Postgres would otherwise produce non-deterministically.
  function createBarrier(parties: number): () => Promise<void> {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    return async () => {
      arrived += 1;
      if (arrived >= parties) {
        release();
      }
      await gate;
    };
  }

  /**
   * In-memory stand-in for Postgres under its default ReadCommitted isolation:
   *
   *  - `findUnique` returns the latest committed row (a snapshot; it does not
   *    lock, so a concurrent writer can invalidate it).
   *  - `updateMany` re-evaluates its `where` filter atomically against the
   *    latest committed row version. That is why a conditional write is a valid
   *    concurrency guard while a prior `findUnique` is not.
   *
   * Modelling only these two rules is enough to tell a correct implementation
   * from a racy one, and it holds the service to the weakest isolation level it
   * could run under rather than assuming a stronger one saves it.
   */
  function createFakeDb(initial: { vipLevel: number; balance: number }) {
    const state = { ...initial };
    const ledger: Array<Record<string, unknown>> = [];
    const onRead = createBarrier(2);

    const tx = {
      user: {
        findUnique: async ({ where }: any) => {
          const snapshot = { id: where.id, vipLevel: state.vipLevel };
          // Both callers read before either writes — the real overlap.
          await onRead();
          return snapshot;
        },
        findUniqueOrThrow: async ({ where }: any) => ({
          id: where.id,
          vipLevel: state.vipLevel,
          creditScore: 100,
        }),
        updateMany: async ({ where, data }: any) => {
          const floor = where.vipLevel?.lt;
          if (floor !== undefined && state.vipLevel >= floor) {
            return { count: 0 };
          }
          state.vipLevel = data.vipLevel;
          return { count: 1 };
        },
      },
      wallet: {
        upsert: async () => ({ userID: 'user-1', balance: state.balance }),
        updateMany: async ({ where, data }: any) => {
          const minimum = where.balance?.gte;
          if (minimum !== undefined && state.balance < minimum) {
            return { count: 0 };
          }
          state.balance -= data.balance.decrement;
          return { count: 1 };
        },
        findUniqueOrThrow: async () => ({
          id: 'wallet-1',
          userID: 'user-1',
          balance: state.balance,
        }),
      },
      coinTransaction: {
        create: async ({ data }: any) => {
          ledger.push(data);
          return { id: `tx-${ledger.length}` };
        },
      },
    };

    return {
      state,
      ledger,
      prisma: {
        $transaction: async (
          callback: (client: typeof tx) => Promise<unknown>,
        ) => callback(tx),
      },
    };
  }

  const realtimeService = {
    broadcastMembershipStatus: jest.fn(),
    broadcastWalletBalanceChanged: jest.fn(),
    broadcastSystemNotificationCreated: jest.fn(),
    broadcastNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
    broadcastUserProfileSummary: jest.fn(),
    invalidateUserHotCache: jest.fn(() => Promise.resolve()),
    safeBroadcastAll: jest.fn((fns: Array<() => void | Promise<void>>) =>
      Promise.allSettled(fns.map((fn) => fn())),
    ),
  };
  const notificationService = { createSystemNotification: jest.fn() };

  async function buildService(prisma: unknown): Promise<MembershipService> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MembershipService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    return module.get<MembershipService>(MembershipService);
  }

  beforeEach(() => jest.clearAllMocks());

  it('charges once when two upgrades to the same level overlap', async () => {
    // Balance deliberately covers TWO upgrades, so nothing but the service's
    // own concurrency guard can stop the second debit.
    const db = createFakeDb({ vipLevel: 0, balance: VIP1_PRICE * 2 });
    const service = await buildService(db.prisma);

    const results = await Promise.allSettled([
      service.upgrade('user-1', 1),
      service.upgrade('user-1', 1),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(
      BadRequestException,
    );
    // The money assertion: one level bought means one price paid.
    expect(db.state.balance).toBe(VIP1_PRICE);
    expect(db.state.vipLevel).toBe(1);
  });

  it('writes a single PURCHASE ledger row when two upgrades overlap', async () => {
    const db = createFakeDb({ vipLevel: 0, balance: VIP1_PRICE * 2 });
    const service = await buildService(db.prisma);

    await Promise.allSettled([
      service.upgrade('user-1', 1),
      service.upgrade('user-1', 1),
    ]);

    // A second row here would mean the loser of the race still debited the
    // wallet, leaving the user billed twice for one level.
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]).toMatchObject({
      type: 'PURCHASE',
      amount: -VIP1_PRICE,
    });
  });
});

describe('MembershipService idempotency scoping (PR #120 review)', () => {
  const realtime = {
    invalidateUserHotCache: jest.fn(() => Promise.resolve()),
    safeBroadcastAll: jest.fn(() => Promise.resolve([])),
    broadcastMembershipStatus: jest.fn(),
    broadcastWalletBalanceChanged: jest.fn(),
    broadcastSystemNotificationCreated: jest.fn(),
  };
  const notification = { createSystemNotification: jest.fn() };

  function buildService(priorTx: unknown) {
    const prisma = {
      coinTransaction: { findUnique: jest.fn().mockResolvedValue(priorTx) },
      user: { findUniqueOrThrow: jest.fn() },
      wallet: { findUniqueOrThrow: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new MembershipService(
      prisma as never,
      realtime as never,
      notification as never,
    );
    return { service, prisma };
  }

  it('rejects a key that belongs to another user instead of replaying success', async () => {
    const { service, prisma } = buildService({
      id: 'tx-1',
      userID: 'someone-else',
      type: 'PURCHASE',
      amount: -780,
      note: '兑换 VIP1',
    });

    await expect(
      service.upgrade('user-1', 1, 'stolen-key'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'MEMBERSHIP_IDEMPOTENCY_KEY_REUSED',
      }),
    });
    // 既不回放成功，也不进扣费事务
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects reusing a VIP1 key for a VIP2 purchase (different parameters)', async () => {
    const { service, prisma } = buildService({
      id: 'tx-1',
      userID: 'user-1',
      type: 'PURCHASE',
      amount: -780,
      note: '兑换 VIP1',
    });

    await expect(
      service.upgrade('user-1', 2, 'vip1-key'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'MEMBERSHIP_IDEMPOTENCY_KEY_REUSED',
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('replays success when the same key loses the race to a committed twin (round 2)', async () => {
    // 预检时无成交行（对手还没提交）→ 事务 CAS 输掉（LevelNotHigher）
    // → 复查发现同键成交已存在且参数吻合 → 回放成功而非报错
    const prisma = {
      coinTransaction: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(null) // 预检
          .mockResolvedValue({
            userID: 'user-1',
            type: 'PURCHASE',
            amount: -780,
            note: '兑换 VIP1',
          }), // 输后复查
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ id: 'user-1', vipLevel: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'user-1',
          vipLevel: 1,
          creditScore: 100,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      wallet: {
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'wallet-1',
          userID: 'user-1',
          balance: 20,
        }),
      },
      $transaction: jest.fn(async (fn: any) => fn(prisma)),
    };
    const service = new MembershipService(
      prisma as never,
      realtime as never,
      notification as never,
    );

    const result = await service.upgrade('user-1', 1, 'racing-key');

    expect(result.user.vipLevel).toBe(1);
    // 复查发生在 CAS 失败之后（findUnique 被调了两次）
    expect(prisma.coinTransaction.findUnique).toHaveBeenCalledTimes(2);
  });

  it('replays current state for a true same-purchase retry', async () => {
    const { service, prisma } = buildService({
      id: 'tx-1',
      userID: 'user-1',
      type: 'PURCHASE',
      amount: -780,
      note: '兑换 VIP1',
    });
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      id: 'user-1',
      vipLevel: 1,
      creditScore: 100,
    });
    prisma.wallet.findUniqueOrThrow.mockResolvedValue({
      id: 'wallet-1',
      userID: 'user-1',
      balance: 20,
    });

    const result = await service.upgrade('user-1', 1, 'same-key');

    expect(result.user.vipLevel).toBe(1);
    expect(prisma.$transaction).not.toHaveBeenCalled(); // 不再扣一次费
  });
});
