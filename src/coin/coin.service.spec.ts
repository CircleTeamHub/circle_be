import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CoinService } from './coin.service';

const IDEM = 'idem-key-1';

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
      upsert: jest.fn(),
    },
    coinGift: {
      findUnique: jest.fn(),
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

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [CoinService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<CoinService>(CoinService);
  });

  it('rejects gifts to missing or inactive recipients', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'BANNED',
    });

    await expect(
      service.sendGift('sender-1', 'recipient-1', 100, IDEM, 'hi'),
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
      service.sendGift('sender-1', 'recipient-1', 600, IDEM, 'happy birthday'),
    ).rejects.toThrow(BadRequestException);

    expect(tx.wallet.update).not.toHaveBeenCalled();
    expect(tx.coinGift.create).not.toHaveBeenCalled();
    expect(tx.coinTransaction.createMany).not.toHaveBeenCalled();
  });

  function arrangeHealthyGift() {
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
    prisma.coinGift.findUnique.mockResolvedValue(null);
    tx.coinTransaction.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    tx.wallet.upsert.mockResolvedValue({ userID: 'x', balance: 0 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 900 });
    tx.wallet.update.mockResolvedValue({ balance: 100 });
    tx.coinGift.create.mockResolvedValue({ id: 'gift-1' });
    tx.coinTransaction.createMany.mockResolvedValue({ count: 2 });
  }

  it('sends a gift: debits sender, credits recipient, records gift + 2 txs', async () => {
    arrangeHealthyGift();

    await service.sendGift(
      'sender-1',
      'recipient-1',
      100,
      IDEM,
      'happy birthday',
    );

    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userID: 'sender-1', balance: { gte: 100 } },
      data: { balance: { decrement: 100 } },
    });
    expect(tx.wallet.update).toHaveBeenCalledWith({
      where: { userID: 'recipient-1' },
      data: { balance: { increment: 100 } },
      select: { balance: true },
    });
    expect(tx.coinGift.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: IDEM }),
    });
    expect(tx.coinTransaction.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ type: 'GIFT_SENT', amount: -100 }),
        expect.objectContaining({ type: 'GIFT_RECEIVED', amount: 100 }),
      ],
    });
  });

  it('is idempotent: a reused idempotencyKey does not charge again', async () => {
    arrangeHealthyGift();
    prisma.coinGift.findUnique.mockResolvedValue({ id: 'gift-prior' });

    await service.sendGift('sender-1', 'recipient-1', 100, IDEM, 'retry');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.coinGift.create).not.toHaveBeenCalled();
  });

  it('rejects gifting yourself before any DB work', async () => {
    await expect(
      service.sendGift('sender-1', 'sender-1', 100, IDEM),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a single gift above the per-gift cap', async () => {
    await expect(
      service.sendGift('sender-1', 'recipient-1', 10_001, IDEM),
    ).rejects.toThrow(/more than/i);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a gift to a non-friend', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue(null);

    await expect(
      service.sendGift('sender-1', 'recipient-1', 100, IDEM),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a gift that would exceed the daily limit', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'recipient-1',
      status: 'ACTIVE',
    });
    prisma.friend.findFirst.mockResolvedValue({
      id: 'friendship-1',
      state: 'ACCEPTED',
    });
    prisma.coinGift.findUnique.mockResolvedValue(null);
    tx.coinTransaction.aggregate.mockResolvedValue({
      _sum: { amount: -49_500 },
    });
    tx.wallet.upsert.mockResolvedValue({ userID: 'x', balance: 100_000 });

    await expect(
      service.sendGift('sender-1', 'recipient-1', 1_000, IDEM),
    ).rejects.toThrow(/daily gift limit/i);
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('adminTopUp rejects a non-positive amount', async () => {
    await expect(service.adminTopUp('user-1', 0)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('adminTopUp rejects an amount above the cap', async () => {
    await expect(service.adminTopUp('user-1', 1_000_001)).rejects.toThrow(
      /cap/i,
    );
  });

  it('adminTopUp rejects a missing target user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.adminTopUp('ghost', 500)).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('adminTopUp credits the wallet and records a RECHARGE tx', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: 'ACTIVE',
    });
    tx.wallet.upsert.mockResolvedValue({
      id: 'wallet-1',
      userID: 'user-1',
      balance: 500,
    });
    tx.coinTransaction.create.mockResolvedValue({ id: 'tx-1' });

    const wallet = await service.adminTopUp('user-1', 500, 'launch bonus');

    expect(wallet.balance).toBe(500);
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'RECHARGE', amount: 500 }),
    });
  });

  it('getWallet upserts so concurrent first access cannot collide', async () => {
    prisma.wallet.upsert.mockResolvedValue({
      id: 'wallet-1',
      userID: 'user-1',
      balance: 0,
    });

    const wallet = await service.getWallet('user-1');

    expect(wallet.balance).toBe(0);
    expect(prisma.wallet.upsert).toHaveBeenCalledWith({
      where: { userID: 'user-1' },
      update: {},
      create: { userID: 'user-1' },
    });
  });
});
