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
      update: jest.fn(),
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
    tx.user.update.mockResolvedValue({
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
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { vipLevel: 3 },
      select: { id: true, vipLevel: true, creditScore: true },
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
});
