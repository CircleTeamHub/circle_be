import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CoinService } from './coin.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { NotificationService } from 'src/notification/notification.service';

describe('CoinService', () => {
  let service: CoinService;

  const tx = {
    wallet: {
      upsert: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
    },
    coinGift: {
      create: jest.fn(),
    },
    coinTransaction: {
      createMany: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    },
  };

  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
    friend: {
      findFirst: jest.fn(),
    },
    wallet: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    coinTransaction: {
      findMany: jest.fn(),
      aggregate: jest.fn(),
    },
    $transaction: jest.fn(
      async (
        callback: (transaction: typeof tx) => Promise<unknown>,
      ): Promise<unknown> => callback(tx),
    ),
  };

  const realtimeService = {
    broadcastWalletBalanceChanged: jest.fn(),
    broadcastWalletRechargeCompleted: jest.fn(),
    broadcastSystemNotificationCreated: jest.fn(),
    broadcastSystemNotificationUnread: jest.fn(),
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
        CoinService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtimeService },
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    service = module.get<CoinService>(CoinService);
  });

  it('rejects gifts to missing or inactive recipients', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'BANNED',
    });

    await expect(
      service.sendGift('sender-1', 'recipient-1', 100, 'hi'),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.friend.findFirst).not.toHaveBeenCalled();
  });

  it('fails when the sender balance cannot be decremented atomically', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      userID: 'sender-1',
      friendID: 'recipient-1',
      state: 'ACCEPTED',
    });
    tx.coinTransaction.aggregate.mockResolvedValue({
      _sum: { amount: -100 },
    });
    tx.wallet.upsert
      .mockResolvedValueOnce({
        id: 'wallet-sender',
        userID: 'sender-1',
        balance: 1_000,
      })
      .mockResolvedValueOnce({
        id: 'wallet-recipient',
        userID: 'recipient-1',
        balance: 0,
      });
    tx.wallet.updateMany.mockResolvedValue({ count: 0 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 400 });
    tx.wallet.update
      .mockResolvedValueOnce({ balance: 400 })
      .mockResolvedValueOnce({ balance: 600 });
    tx.coinGift.create.mockResolvedValue({ id: 'gift-1' });
    tx.coinTransaction.createMany.mockResolvedValue({ count: 2 });

    await expect(
      service.sendGift('sender-1', 'recipient-1', 600, 'happy birthday'),
    ).rejects.toThrow(BadRequestException);

    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.coinGift.create).not.toHaveBeenCalled();
    expect(tx.coinTransaction.createMany).not.toHaveBeenCalled();
  });
});
