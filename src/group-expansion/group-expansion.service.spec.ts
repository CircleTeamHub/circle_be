import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { GroupExpansionService } from './group-expansion.service';

describe('GroupExpansionService', () => {
  const now = new Date('2026-07-28T12:00:00.000Z');
  const tx = {
    groupExpansionOrder: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    circle: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
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
    circle: tx.circle,
    groupExpansionOrder: tx.groupExpansionOrder,
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const membershipPolicy = {
    resolveEntitlement: jest.fn(),
    getUserPolicy: jest.fn(),
  };
  const realtime = {
    safeBroadcastAll: jest.fn(
      async (callbacks: Array<() => unknown | Promise<unknown>>) =>
        Promise.all(callbacks.map((callback) => callback())),
    ),
    broadcastWalletBalanceChanged: jest.fn(),
  };
  let service: GroupExpansionService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        GroupExpansionService,
        { provide: PrismaService, useValue: prisma },
        { provide: MembershipPolicyService, useValue: membershipPolicy },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    service = module.get(GroupExpansionService);

    tx.groupExpansionOrder.findUnique.mockResolvedValue(null);
    tx.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      maxMembers: 200,
      expansionSeats: 0,
      memberCount: 150,
    });
    tx.user.findUnique.mockResolvedValue({
      vipLevel: 1,
      vipExpiresAt: new Date('2026-08-28T00:00:00.000Z'),
    });
    membershipPolicy.resolveEntitlement.mockResolvedValue({
      tier: { quotas: { groupMembers: { actual: 200 } } },
    });
    tx.wallet.upsert.mockResolvedValue({ balance: 1500 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 1320 });
    tx.circle.update.mockResolvedValue({});
    tx.groupExpansionOrder.create.mockResolvedValue({ id: 'order-1' });
  });

  it('atomically buys a permanent bundle and records the purchase', async () => {
    const result = await service.purchase(
      'user-1',
      'circle-1',
      'advanced',
      'request-1',
      { price: 180, seats: 200 },
      now,
    );

    expect(result).toEqual({
      orderId: 'order-1',
      circleId: 'circle-1',
      productId: 'advanced',
      productName: '进阶扩群卡',
      seats: 200,
      price: 180,
      previousMaxMembers: 200,
      newMaxMembers: 400,
      walletBalanceAfter: 1320,
    });
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', balance: { gte: 180 } },
      data: { balance: { decrement: 180 } },
    });
    expect(tx.circle.update).toHaveBeenCalledWith({
      where: { id: 'circle-1' },
      data: {
        expansionSeats: { increment: 200 },
        maxMembers: 400,
      },
    });
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-1',
        type: 'PURCHASE',
        amount: -180,
        balance: 1320,
        note: '进阶扩群卡：群永久扩容 200 人',
        relatedID: 'order-1',
        idempotencyKey: 'group-expansion:client:user-1:request-1',
      },
    });
    expect(realtime.broadcastWalletBalanceChanged).toHaveBeenCalledWith(
      'user-1',
      { reason: 'PURCHASE', delta: -180 },
    );
  });

  it('rejects a stale displayed quote before debiting the wallet', async () => {
    await expect(
      service.purchase(
        'user-1',
        'circle-1',
        'advanced',
        'stale-quote',
        { price: 100, seats: 200 },
        now,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'GROUP_EXPANSION_QUOTE_CHANGED',
      }),
    });

    expect(tx.wallet.upsert).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.circle.update).not.toHaveBeenCalled();
  });

  it('rolls back when the wallet has insufficient points', async () => {
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.purchase(
        'user-1',
        'circle-1',
        'advanced',
        'request-2',
        undefined,
        now,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(tx.circle.update).not.toHaveBeenCalled();
    expect(tx.groupExpansionOrder.create).not.toHaveBeenCalled();
  });

  it('does not expose or mutate a circle owned by another user', async () => {
    tx.circle.findFirst.mockResolvedValue(null);

    await expect(
      service.purchase(
        'user-2',
        'circle-1',
        'light',
        'request-3',
        undefined,
        now,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a bundle that cannot add its full seat count below 3000', async () => {
    tx.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      maxMembers: 2950,
      expansionSeats: 1950,
      memberCount: 2900,
    });
    membershipPolicy.resolveEntitlement.mockResolvedValue({
      tier: { quotas: { groupMembers: { actual: 1000 } } },
    });

    await expect(
      service.purchase(
        'user-1',
        'circle-1',
        'light',
        'request-4',
        undefined,
        now,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('returns the original order for an identical idempotent retry', async () => {
    tx.groupExpansionOrder.findUnique.mockResolvedValue({
      id: 'order-existing',
      requestFingerprint: 'circle-1:light',
      circleID: 'circle-1',
      productID: 'light',
      productName: '轻量扩群卡',
      seats: 100,
      price: 600,
      previousMaxMembers: 200,
      newMaxMembers: 300,
      walletBalanceAfter: 900,
    });

    const result = await service.purchase(
      'user-1',
      'circle-1',
      'light',
      'request-5',
      undefined,
      now,
    );

    expect(result.orderId).toBe('order-existing');
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.circle.update).not.toHaveBeenCalled();
    expect(realtime.safeBroadcastAll).not.toHaveBeenCalled();
  });

  it('replays a committed quoted order even after the catalog quote changes', async () => {
    const requestFingerprint = JSON.stringify({
      circleId: 'circle-1',
      productId: 'light',
      expectedPrice: 90,
      expectedSeats: 100,
    });
    tx.groupExpansionOrder.findUnique.mockResolvedValue({
      id: 'order-quoted',
      requestFingerprint,
      circleID: 'circle-1',
      productID: 'light',
      productName: '轻量扩群卡',
      seats: 100,
      price: 90,
      previousMaxMembers: 200,
      newMaxMembers: 300,
      walletBalanceAfter: 910,
    });

    await expect(
      service.purchase(
        'user-1',
        'circle-1',
        'light',
        'quoted-retry',
        { price: 90, seats: 100 },
        now,
      ),
    ).resolves.toMatchObject({
      orderId: 'order-quoted',
      price: 90,
    });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('rejects reuse of an idempotency key for a different request', async () => {
    tx.groupExpansionOrder.findUnique.mockResolvedValue({
      id: 'order-existing',
      requestFingerprint: 'circle-1:light',
    });

    await expect(
      service.purchase(
        'user-1',
        'circle-1',
        'advanced',
        'request-5',
        undefined,
        now,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('lists the catalog with per-circle purchase eligibility', async () => {
    membershipPolicy.getUserPolicy.mockResolvedValue({
      tier: { quotas: { groupMembers: { actual: 200 } } },
    });

    const result = await service.getProducts('user-1', 'circle-1', now);

    expect(result).toMatchObject({
      circleId: 'circle-1',
      memberCount: 150,
      currentMaxMembers: 200,
      expansionSeats: 0,
      hardLimit: 3000,
    });
    expect(result.products).toHaveLength(4);
    expect(result.products[0]).toMatchObject({
      id: 'light',
      seats: 100,
      price: 100,
      purchasable: true,
      unavailableReason: null,
      resultingMaxMembers: 300,
    });
  });

  it('marks a bundle unavailable when it would only partially apply', async () => {
    tx.circle.findFirst.mockResolvedValue({
      id: 'circle-1',
      maxMembers: 2950,
      expansionSeats: 1950,
      memberCount: 2900,
    });
    membershipPolicy.getUserPolicy.mockResolvedValue({
      tier: { quotas: { groupMembers: { actual: 1000 } } },
    });

    const result = await service.getProducts('user-1', 'circle-1', now);

    expect(result.products[0]).toMatchObject({
      id: 'light',
      purchasable: false,
      unavailableReason: 'MAX_CAPACITY_EXCEEDED',
      resultingMaxMembers: 3000,
    });
  });

  it('returns the owner purchase history with cursor pagination', async () => {
    tx.groupExpansionOrder.findMany.mockResolvedValue([
      {
        id: 'order-2',
        circleID: 'circle-1',
        productID: 'advanced',
        productName: '进阶扩群卡',
        seats: 200,
        price: 1100,
        previousMaxMembers: 200,
        newMaxMembers: 400,
        walletBalanceAfter: 400,
        createdAt: new Date('2026-07-28T12:00:00.000Z'),
      },
      {
        id: 'order-1',
        circleID: 'circle-1',
        productID: 'light',
        productName: '轻量扩群卡',
        seats: 100,
        price: 600,
        previousMaxMembers: 100,
        newMaxMembers: 200,
        walletBalanceAfter: 1500,
        createdAt: new Date('2026-07-27T12:00:00.000Z'),
      },
    ]);

    const result = await service.getOrders('user-1', 'circle-1', undefined, 1);

    expect(tx.groupExpansionOrder.findMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', circleID: 'circle-1' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBe('order-2');
  });
});
