import { Test } from '@nestjs/testing';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import { FancyNumberService } from './fancy-number.service';

describe('FancyNumberService', () => {
  const now = new Date('2026-01-31T09:15:30.123Z');
  const tx = {
    fancyNumberOrder: {
      findUnique: jest.fn(),
      create: jest.fn(),
      upsert: jest.fn(),
    },
    fancyNumberLease: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    fancyNumber: {
      count: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
    accountIdentifier: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
    },
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
    adminAuditLog: {
      create: jest.fn(),
    },
    $executeRaw: jest.fn(),
  };
  const prisma = {
    user: tx.user,
    fancyNumber: tx.fancyNumber,
    fancyNumberLease: tx.fancyNumberLease,
    fancyNumberOrder: tx.fancyNumberOrder,
    accountIdentifier: tx.accountIdentifier,
    $transaction: jest.fn(
      async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  };
  const realtime = {
    safeBroadcastAll: jest.fn(async () => []),
    broadcastWalletBalanceChanged: jest.fn(),
    invalidateUserProfileSummaryCache: jest.fn(),
    broadcastUserProfileSummary: jest.fn(),
  };
  let service: FancyNumberService;

  beforeEach(async () => {
    jest.clearAllMocks();
    tx.fancyNumberOrder.findUnique.mockReset();
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);
    tx.fancyNumberLease.findFirst.mockReset();
    tx.fancyNumberLease.findMany.mockReset();
    tx.accountIdentifier.findUnique.mockResolvedValue({
      currentUserID: null,
      reservedForUserID: null,
      inviteOwnerUserID: null,
    });
    const module = await Test.createTestingModule({
      providers: [
        FancyNumberService,
        { provide: PrismaService, useValue: prisma },
        { provide: RealtimeService, useValue: realtime },
      ],
    }).compile();
    service = module.get(FancyNumberService);
  });

  it('checks a custom six-character value without reserving it', async () => {
    tx.accountIdentifier.findUnique.mockResolvedValue(null);

    await expect(
      service.checkCustomAvailability('user-1', ' Ab12c3 '),
    ).resolves.toEqual({
      value: 'AB12C3',
      available: true,
      reason: null,
    });
    expect(tx.accountIdentifier.create).not.toHaveBeenCalled();
    expect(tx.fancyNumber.create).not.toHaveBeenCalled();
  });

  it('reports an existing account identifier as unavailable', async () => {
    tx.accountIdentifier.findUnique.mockResolvedValue({
      currentUserID: 'other-user',
      reservedForUserID: null,
      inviteOwnerUserID: null,
      fancyNumber: null,
    });

    await expect(
      service.checkCustomAvailability('user-1', 'AB12C3'),
    ).resolves.toEqual({
      value: 'AB12C3',
      available: false,
      reason: 'TAKEN',
    });
  });

  it('atomically buys two calendar months for 200 points and switches the public account id', async () => {
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: 'ACTIVE',
      accountId: 'normal01',
      vipLevel: 0,
      vipExpiresAt: null,
    });
    tx.fancyNumberLease.findFirst.mockResolvedValue(null);
    tx.fancyNumber.findUnique.mockResolvedValue({
      id: 'fancy-1',
      value: '888888',
      status: 'AVAILABLE',
    });
    tx.fancyNumber.updateMany.mockResolvedValue({ count: 1 });
    tx.accountIdentifier.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    tx.wallet.upsert.mockResolvedValue({ balance: 250 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 50 });
    tx.fancyNumberLease.create.mockResolvedValue({
      id: 'lease-1',
      expiresAt: new Date('2026-03-31T09:15:30.123Z'),
    });
    tx.fancyNumberOrder.create.mockResolvedValue({ id: 'order-1' });

    const result = await service.purchase(
      'user-1',
      'fancy-1',
      2,
      'request-1',
      now,
    );

    expect(result).toEqual({
      orderId: 'order-1',
      accountId: '888888',
      expiresAt: new Date('2026-03-31T09:15:30.123Z'),
      permanent: false,
      months: 2,
      unitPrice: 100,
      totalPrice: 200,
      walletBalanceAfter: 50,
    });
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userID: 'user-1', balance: { gte: 200 } },
      data: { balance: { decrement: 200 } },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        accountId: '888888',
        fancyNumber: true,
        fancyNumberExpiresAt: new Date('2026-03-31T09:15:30.123Z'),
        fancyNumberPermanent: false,
      },
    });
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-1',
        type: 'PURCHASE',
        amount: -200,
        balance: 50,
        note: '靓号 888888 购买 2 个月',
        relatedID: 'order-1',
        idempotencyKey: 'fancy-number:client:user-1:request-1',
      },
    });
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.user.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('rejects a stale purchase quote before claiming inventory or debiting points', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({
      id: 'user-stale-purchase',
      status: 'ACTIVE',
      accountId: 'normal01',
      vipLevel: 0,
      vipExpiresAt: null,
    });
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);

    await expect(
      service.purchase(
        'user-stale-purchase',
        'fancy-1',
        2,
        'stale-purchase',
        now,
        99,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_QUOTE_CHANGED',
      }),
    });
    expect(tx.fancyNumber.updateMany).not.toHaveBeenCalled();
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('does not rebroadcast purchase mutations when replaying an idempotent order', async () => {
    const expiresAt = new Date('2026-03-31T09:15:30.123Z');
    tx.fancyNumberLease.findFirst.mockResolvedValueOnce(null);
    tx.user.findUnique.mockResolvedValue({
      id: 'user-replay',
      status: 'ACTIVE',
      accountId: '888888',
      vipLevel: 0,
      vipExpiresAt: null,
    });
    tx.fancyNumberOrder.findUnique.mockResolvedValue({
      id: 'order-replay',
      idempotencyKey: 'client:user-replay:request-replay',
      requestFingerprint: JSON.stringify({
        operation: 'purchase',
        userId: 'user-replay',
        fancyNumberId: 'fancy-replay',
        months: 1,
      }),
      fancyNumberID: 'fancy-replay',
      newExpiresAt: expiresAt,
      months: 1,
      unitPrice: 100,
      totalPrice: 100,
      walletBalanceAfter: 400,
    });
    tx.fancyNumber.findUniqueOrThrow.mockResolvedValue({ value: '888888' });

    await expect(
      service.purchase('user-replay', 'fancy-replay', 1, 'request-replay', now),
    ).resolves.toMatchObject({
      orderId: 'order-replay',
      walletBalanceAfter: 400,
    });
    expect(realtime.safeBroadcastAll).not.toHaveBeenCalled();
  });

  it('replays a paid purchase after the member upgrades to Super', async () => {
    const expiresAt = new Date('2026-02-28T09:15:30.123Z');
    tx.user.findUnique.mockResolvedValue({
      id: 'user-upgraded',
      status: 'ACTIVE',
      accountId: '888888',
      vipLevel: 4,
      vipExpiresAt: null,
    });
    tx.fancyNumberOrder.findUnique.mockResolvedValue({
      id: 'order-paid-before-upgrade',
      requestFingerprint: JSON.stringify({
        operation: 'purchase',
        userId: 'user-upgraded',
        fancyNumberId: 'fancy-paid',
        months: 1,
      }),
      fancyNumberID: 'fancy-paid',
      newExpiresAt: expiresAt,
      months: 1,
      unitPrice: 100,
      totalPrice: 100,
      walletBalanceAfter: 300,
    });
    tx.fancyNumber.findUniqueOrThrow.mockResolvedValue({ value: '888888' });

    await expect(
      service.purchase(
        'user-upgraded',
        'fancy-paid',
        1,
        'request-before-upgrade',
        now,
      ),
    ).resolves.toMatchObject({
      orderId: 'order-paid-before-upgrade',
      permanent: false,
      months: 1,
      totalPrice: 100,
    });
  });

  it('lets a super member choose one permanent fancy number without spending points', async () => {
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({
      id: 'super-1',
      status: 'ACTIVE',
      accountId: 'normal02',
      vipLevel: 4,
      vipExpiresAt: null,
    });
    tx.fancyNumberLease.findFirst.mockResolvedValue(null);
    tx.fancyNumber.findUnique.mockResolvedValue({
      id: 'fancy-2',
      value: '666666',
      status: 'AVAILABLE',
    });
    tx.fancyNumber.updateMany.mockResolvedValue({ count: 1 });
    tx.accountIdentifier.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    tx.wallet.upsert.mockResolvedValue({ balance: 40 });
    tx.fancyNumberLease.create.mockResolvedValue({
      id: 'lease-2',
      expiresAt: null,
    });
    tx.fancyNumberOrder.create.mockResolvedValue({ id: 'order-2' });

    const result = await service.purchase(
      'super-1',
      'fancy-2',
      1,
      'request-2',
      now,
    );

    expect(result).toEqual({
      orderId: 'order-2',
      accountId: '666666',
      expiresAt: null,
      permanent: true,
      months: null,
      unitPrice: 100,
      totalPrice: 0,
      walletBalanceAfter: 40,
    });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.coinTransaction.create).not.toHaveBeenCalled();
    expect(tx.fancyNumber.updateMany).toHaveBeenCalledWith({
      where: { id: 'fancy-2', status: 'AVAILABLE' },
      data: { status: 'PERMANENT', disabledAt: null },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'super-1' },
      data: {
        accountId: '666666',
        fancyNumber: true,
        fancyNumberExpiresAt: null,
        fancyNumberPermanent: true,
      },
    });
    expect(tx.fancyNumberOrder.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          requestFingerprint: JSON.stringify({
            operation: 'purchase',
            userId: 'super-1',
            fancyNumberId: 'fancy-2',
            months: null,
          }),
        }),
      }),
    );

    tx.fancyNumberOrder.findUnique.mockResolvedValue({
      id: 'order-2',
      idempotencyKey: 'fancy-number:client:super-1:request-2',
      requestFingerprint: JSON.stringify({
        operation: 'purchase',
        userId: 'super-1',
        fancyNumberId: 'fancy-2',
        months: null,
      }),
      fancyNumberID: 'fancy-2',
      newExpiresAt: null,
      months: null,
      unitPrice: 100,
      totalPrice: 0,
      walletBalanceAfter: 40,
    });
    tx.fancyNumber.findUniqueOrThrow.mockResolvedValue({ value: '666666' });

    await expect(
      service.purchase('super-1', 'fancy-2', undefined, 'request-2', now),
    ).resolves.toEqual(result);
    expect(tx.fancyNumberOrder.create).toHaveBeenCalledTimes(1);
  });

  it('creates and buys a custom fancy number only inside the purchase transaction', async () => {
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);
    tx.user.findUnique.mockResolvedValue({
      id: 'user-custom',
      status: 'ACTIVE',
      accountId: 'normal03',
      vipLevel: 0,
      vipExpiresAt: null,
    });
    tx.fancyNumberLease.findFirst.mockResolvedValue(null);
    tx.fancyNumber.findUnique.mockResolvedValue(null);
    tx.accountIdentifier.findUnique.mockResolvedValue(null);
    tx.accountIdentifier.create.mockResolvedValue({ value: 'ab12c3' });
    tx.fancyNumber.create.mockResolvedValue({
      id: 'fancy-custom',
      value: 'ab12c3',
      status: 'AVAILABLE',
    });
    tx.fancyNumber.updateMany.mockResolvedValue({ count: 1 });
    tx.accountIdentifier.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    tx.wallet.upsert.mockResolvedValue({ balance: 300 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 200 });
    tx.fancyNumberLease.create.mockResolvedValue({
      id: 'lease-custom',
      expiresAt: new Date('2026-02-28T09:15:30.123Z'),
    });
    tx.fancyNumberOrder.create.mockResolvedValue({ id: 'order-custom' });

    const result = await service.purchaseCustom(
      'user-custom',
      'Ab12c3',
      1,
      'custom-request',
      now,
    );

    expect(tx.accountIdentifier.create).toHaveBeenCalledWith({
      data: { value: 'ab12c3' },
    });
    expect(tx.fancyNumber.create).toHaveBeenCalledWith({
      data: {
        value: 'ab12c3',
        source: 'CUSTOM',
        status: 'AVAILABLE',
        createdByUserID: 'user-custom',
      },
      select: { id: true, value: true, status: true },
    });
    expect(result).toMatchObject({
      accountId: 'AB12C3',
      totalPrice: 100,
      walletBalanceAfter: 200,
    });
  });

  it('switches a permanent fancy number and disables the released invite-owned number', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-permanent',
      userID: 'user-permanent',
      fancyNumberID: 'fancy-old',
      restoreAccountId: 'normal01',
      expiresAt: null,
      permanentAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: null,
      user: { accountId: '888888', status: 'ACTIVE' },
      fancyNumber: { id: 'fancy-old', value: '888888' },
    });
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);
    tx.fancyNumber.findUnique.mockResolvedValue({
      id: 'fancy-new',
      value: '999999',
      status: 'AVAILABLE',
    });
    tx.accountIdentifier.findUnique
      .mockResolvedValueOnce({
        currentUserID: null,
        reservedForUserID: null,
        inviteOwnerUserID: null,
      })
      .mockResolvedValueOnce({
        currentUserID: null,
        reservedForUserID: null,
        inviteOwnerUserID: 'invite-owner',
      });
    tx.fancyNumber.updateMany.mockResolvedValue({ count: 1 });
    tx.accountIdentifier.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    tx.wallet.upsert.mockResolvedValue({ balance: 250 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 150 });
    tx.fancyNumberLease.update.mockResolvedValue({ id: 'lease-permanent' });
    tx.fancyNumberOrder.create.mockResolvedValue({ id: 'order-switch' });

    const result = await service.switchPermanent(
      'user-permanent',
      'fancy-new',
      'switch-request',
      now,
    );

    expect(result).toEqual({
      orderId: 'order-switch',
      accountId: '999999',
      expiresAt: null,
      permanent: true,
      months: null,
      unitPrice: 100,
      totalPrice: 100,
      walletBalanceAfter: 150,
    });
    expect(tx.wallet.updateMany).toHaveBeenCalledWith({
      where: { userID: 'user-permanent', balance: { gte: 100 } },
      data: { balance: { decrement: 100 } },
    });
    expect(tx.accountIdentifier.updateMany).toHaveBeenNthCalledWith(1, {
      where: { value: '888888', currentUserID: 'user-permanent' },
      data: { currentUserID: null },
    });
    expect(tx.accountIdentifier.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        value: '999999',
        currentUserID: null,
        reservedForUserID: null,
        inviteOwnerUserID: null,
      },
      data: { currentUserID: 'user-permanent' },
    });
    expect(tx.fancyNumber.updateMany).toHaveBeenCalledWith({
      where: { id: 'fancy-new', status: 'AVAILABLE' },
      data: { status: 'PERMANENT', disabledAt: null },
    });
    expect(tx.fancyNumber.updateMany).toHaveBeenCalledWith({
      where: { id: 'fancy-old', status: 'PERMANENT' },
      data: { status: 'DISABLED', disabledAt: now },
    });
    expect(tx.fancyNumberLease.update).toHaveBeenCalledWith({
      where: { id: 'lease-permanent' },
      data: { fancyNumberID: 'fancy-new' },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-permanent' },
      data: {
        accountId: '999999',
        fancyNumber: true,
        fancyNumberExpiresAt: null,
        fancyNumberPermanent: true,
      },
    });
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-permanent',
        type: 'PURCHASE',
        amount: -100,
        balance: 150,
        note: '永久靓号 888888 更换为 999999',
        relatedID: 'order-switch',
        idempotencyKey: 'fancy-number:client:user-permanent:switch-request',
      },
    });
  });

  it('rejects a stale permanent-switch quote before debiting points', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-stale-switch',
      userID: 'user-stale-switch',
      fancyNumberID: 'fancy-old',
      restoreAccountId: 'normal01',
      expiresAt: null,
      permanentAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: null,
      user: { accountId: '888888', status: 'ACTIVE' },
      fancyNumber: { id: 'fancy-old', value: '888888' },
    });
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);

    await expect(
      service.switchPermanent(
        'user-stale-switch',
        'fancy-new',
        'stale-switch',
        now,
        99,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_QUOTE_CHANGED',
      }),
    });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.fancyNumber.updateMany).not.toHaveBeenCalled();
  });

  it('replays a permanent-number switch idempotently without a second debit', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-permanent',
      userID: 'user-permanent',
      fancyNumberID: 'fancy-new',
      restoreAccountId: 'normal01',
      expiresAt: null,
      permanentAt: new Date('2026-01-01T00:00:00.000Z'),
      endedAt: null,
      user: { accountId: '999999', status: 'ACTIVE' },
      fancyNumber: { id: 'fancy-new', value: '999999' },
    });
    tx.fancyNumberOrder.findUnique.mockResolvedValue({
      id: 'order-switch',
      requestFingerprint: JSON.stringify({
        operation: 'switch',
        userId: 'user-permanent',
        leaseId: 'lease-permanent',
        fancyNumberId: 'fancy-new',
      }),
      fancyNumberID: 'fancy-new',
      unitPrice: 100,
      totalPrice: 100,
      walletBalanceAfter: 150,
    });
    tx.fancyNumber.findUniqueOrThrow.mockResolvedValue({ value: '999999' });

    await expect(
      service.switchPermanent(
        'user-permanent',
        'fancy-new',
        'switch-request',
        now,
      ),
    ).resolves.toEqual({
      orderId: 'order-switch',
      accountId: '999999',
      expiresAt: null,
      permanent: true,
      months: null,
      unitPrice: 100,
      totalPrice: 100,
      walletBalanceAfter: 150,
    });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.coinTransaction.create).not.toHaveBeenCalled();
    expect(realtime.safeBroadcastAll).not.toHaveBeenCalled();
  });

  it('rejects switching a monthly fancy number before debiting points', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-monthly',
      userID: 'user-monthly',
      fancyNumberID: 'fancy-old',
      restoreAccountId: 'normal02',
      expiresAt: new Date('2026-03-01T00:00:00.000Z'),
      permanentAt: null,
      endedAt: null,
      user: { accountId: '888888', status: 'ACTIVE' },
      fancyNumber: { id: 'fancy-old', value: '888888' },
    });
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);

    await expect(
      service.switchPermanent(
        'user-monthly',
        'fancy-new',
        'switch-monthly',
        now,
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_SWITCH_REQUIRES_PERMANENT',
      }),
    });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
    expect(tx.fancyNumber.updateMany).not.toHaveBeenCalled();
  });

  it('renews from the current expiry and records one purchase debit', async () => {
    tx.fancyNumberLease.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'lease-3',
        userID: 'user-3',
        expiresAt: new Date('2026-03-31T09:15:30.123Z'),
        permanentAt: null,
        endedAt: null,
        fancyNumber: { id: 'fancy-3', value: '999999' },
      });
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);
    tx.wallet.upsert.mockResolvedValue({ balance: 500 });
    tx.wallet.updateMany.mockResolvedValue({ count: 1 });
    tx.wallet.findUniqueOrThrow.mockResolvedValue({ balance: 300 });
    tx.fancyNumberLease.update.mockResolvedValue({
      expiresAt: new Date('2026-05-31T09:15:30.123Z'),
    });
    tx.fancyNumberOrder.create.mockResolvedValue({ id: 'order-3' });

    const result = await service.renew(
      'user-3',
      2,
      'renew-request',
      new Date('2026-02-01T00:00:00.000Z'),
    );

    expect(result).toEqual({
      orderId: 'order-3',
      accountId: '999999',
      expiresAt: new Date('2026-05-31T09:15:30.123Z'),
      permanent: false,
      months: 2,
      unitPrice: 100,
      totalPrice: 200,
      walletBalanceAfter: 300,
    });
    expect(tx.fancyNumberLease.update).toHaveBeenCalledWith({
      where: { id: 'lease-3' },
      data: { expiresAt: new Date('2026-05-31T09:15:30.123Z') },
      select: { expiresAt: true },
    });
    expect(tx.coinTransaction.create).toHaveBeenCalledWith({
      data: {
        userID: 'user-3',
        type: 'PURCHASE',
        amount: -200,
        balance: 300,
        note: '靓号 999999 续费 2 个月',
        relatedID: 'order-3',
        idempotencyKey: 'fancy-number:client:user-3:renew-request',
      },
    });
  });

  it('rejects a stale renewal quote before debiting points', async () => {
    tx.fancyNumberLease.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'lease-stale-renewal',
        userID: 'user-stale-renewal',
        expiresAt: new Date('2026-03-31T09:15:30.123Z'),
        permanentAt: null,
        endedAt: null,
        fancyNumber: { id: 'fancy-stale-renewal', value: '999999' },
      });
    tx.fancyNumberOrder.findUnique.mockResolvedValue(null);

    await expect(
      service.renew('user-stale-renewal', 2, 'stale-renewal', now, 101),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_QUOTE_CHANGED',
      }),
    });
    expect(tx.wallet.updateMany).not.toHaveBeenCalled();
  });

  it('does not rebroadcast a wallet debit when replaying an idempotent renewal', async () => {
    const previousExpiresAt = new Date('2026-03-31T09:15:30.123Z');
    const newExpiresAt = new Date('2026-04-30T09:15:30.123Z');
    tx.fancyNumberLease.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'lease-renew-replay',
        userID: 'user-renew-replay',
        expiresAt: previousExpiresAt,
        permanentAt: null,
        endedAt: null,
        fancyNumber: { id: 'fancy-switched', value: '666666' },
      });
    tx.fancyNumberOrder.findUnique.mockResolvedValue({
      id: 'order-renew-replay',
      requestFingerprint: JSON.stringify({
        operation: 'renewal',
        userId: 'user-renew-replay',
        leaseId: 'lease-renew-replay',
        months: 1,
      }),
      newExpiresAt,
      months: 1,
      unitPrice: 100,
      totalPrice: 100,
      walletBalanceAfter: 300,
      fancyNumber: { value: '999999' },
    });

    await expect(
      service.renew('user-renew-replay', 1, 'renew-replay', now),
    ).resolves.toMatchObject({
      orderId: 'order-renew-replay',
      accountId: '999999',
      expiresAt: newExpiresAt,
      walletBalanceAfter: 300,
    });
    expect(realtime.safeBroadcastAll).not.toHaveBeenCalled();
  });

  it('replays a successful renewal before trying to expire its now-overdue lease', async () => {
    const newExpiresAt = new Date('2026-02-28T09:15:30.123Z');
    tx.fancyNumberOrder.findUnique.mockResolvedValue({
      id: 'order-expired-replay',
      requestFingerprint: JSON.stringify({
        operation: 'renewal',
        userId: 'user-expired-replay',
        leaseId: 'lease-expired-replay',
        months: 1,
      }),
      newExpiresAt,
      months: 1,
      unitPrice: 100,
      totalPrice: 100,
      walletBalanceAfter: 300,
      fancyNumber: { value: '999999' },
    });
    const expireSpy = jest
      .spyOn(service as any, 'expireOverdueLeaseForUser')
      .mockResolvedValue(true);

    await expect(
      service.renew(
        'user-expired-replay',
        1,
        'expired-replay',
        new Date('2026-03-01T00:00:00.000Z'),
      ),
    ).resolves.toMatchObject({
      orderId: 'order-expired-replay',
      accountId: '999999',
      expiresAt: newExpiresAt,
    });
    expect(expireSpy).not.toHaveBeenCalled();
  });

  it('does not enable a disabled fancy number with a durable identifier claim', async () => {
    tx.fancyNumber.findUnique.mockResolvedValue({
      id: 'fancy-invite-owned',
      value: '888888',
      status: 'DISABLED',
    });
    tx.accountIdentifier.findUnique.mockResolvedValue({
      currentUserID: null,
      reservedForUserID: null,
      inviteOwnerUserID: 'invite-owner',
    });

    await expect(
      service.adminSetAvailability('admin-1', 'fancy-invite-owned', true),
    ).rejects.toThrow('Fancy number has an identifier claim');
    expect(tx.fancyNumber.update).not.toHaveBeenCalled();
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('restores an overdue lease before rejecting renewal', async () => {
    const expiredAt = new Date('2026-01-31T00:00:00.000Z');
    tx.fancyNumberLease.findFirst.mockResolvedValueOnce({
      id: 'lease-expired',
      expiresAt: expiredAt,
      permanentAt: null,
    });
    const expireSpy = jest
      .spyOn(service, 'expireLease')
      .mockResolvedValue(true);

    await expect(
      service.renew('user-expired', 1, 'renew-expired', now),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_LEASE_EXPIRED',
      }),
    });
    expect(expireSpy).toHaveBeenCalledWith('lease-expired', now);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('continues the expiry sweep after a full batch of failing leases', async () => {
    const failing = Array.from({ length: 100 }, (_, index) => ({
      id: `failed-${String(index).padStart(3, '0')}`,
    }));
    tx.fancyNumberLease.findMany
      .mockResolvedValueOnce(failing)
      .mockResolvedValueOnce([{ id: 'valid-after-failures' }])
      .mockResolvedValueOnce([]);
    const expireSpy = jest
      .spyOn(service, 'expireLease')
      .mockImplementation(async (leaseId) => {
        if (leaseId === 'valid-after-failures') return true;
        throw new Error('invalid identifier state');
      });

    await expect(service.expireDue(now)).resolves.toBe(1);
    expect(expireSpy).toHaveBeenCalledWith('valid-after-failures', now);
  });

  it('restores the reserved account and releases an expired fancy number', async () => {
    const expiredAt = new Date('2026-02-28T09:15:30.123Z');
    tx.fancyNumberLease.findUnique.mockResolvedValue({
      id: 'lease-4',
      userID: 'user-4',
      fancyNumberID: 'fancy-4',
      restoreAccountId: 'normal04',
      expiresAt: expiredAt,
      permanentAt: null,
      endedAt: null,
      user: { accountId: '888888' },
      fancyNumber: { value: '888888' },
    });
    tx.fancyNumberLease.updateMany.mockResolvedValue({ count: 1 });
    tx.accountIdentifier.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      service.expireLease('lease-4', new Date('2026-02-28T09:15:30.123Z')),
    ).resolves.toBe(true);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-4' },
      data: {
        accountId: 'normal04',
        fancyNumber: false,
        fancyNumberExpiresAt: null,
        fancyNumberPermanent: false,
      },
    });
    expect(tx.fancyNumber.updateMany).toHaveBeenCalledWith({
      where: { id: 'fancy-4', status: 'LEASED' },
      data: { status: 'AVAILABLE', disabledAt: null },
    });
    expect(tx.fancyNumberLease.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'lease-4',
        endedAt: null,
        permanentAt: null,
        expiresAt: { lte: new Date('2026-02-28T09:15:30.123Z') },
      },
      data: {
        endedAt: new Date('2026-02-28T09:15:30.123Z'),
        endReason: 'EXPIRED',
      },
    });
  });

  it('adds a normalized deduplicated admin inventory batch and audits it', async () => {
    tx.accountIdentifier.findMany.mockResolvedValue([]);
    tx.accountIdentifier.createMany.mockResolvedValue({ count: 2 });
    tx.fancyNumber.createMany.mockResolvedValue({ count: 2 });
    tx.fancyNumber.findMany.mockResolvedValue([
      { id: 'fancy-b', value: '888888' },
      { id: 'fancy-a', value: 'abcd_1' },
    ]);

    await expect(
      service.adminBatchCreate('admin-1', [' ABCD_1 ', '888888', 'abcd_1']),
    ).resolves.toEqual([
      { id: 'fancy-b', value: '888888' },
      { id: 'fancy-a', value: 'abcd_1' },
    ]);

    expect(tx.accountIdentifier.createMany).toHaveBeenCalledWith({
      data: [{ value: '888888' }, { value: 'abcd_1' }],
    });
    expect(tx.fancyNumber.createMany).toHaveBeenCalledWith({
      data: [
        {
          value: '888888',
          source: 'ADMIN',
          status: 'AVAILABLE',
          createdByUserID: 'admin-1',
          sortOrder: 0,
        },
        {
          value: 'abcd_1',
          source: 'ADMIN',
          status: 'AVAILABLE',
          createdByUserID: 'admin-1',
          sortOrder: 1,
        },
      ],
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorID: 'admin-1',
        action: 'FANCY_NUMBER_BATCH_CREATE',
        entityType: 'FancyNumber',
        metadata: { count: 2, values: ['888888', 'abcd_1'] },
      },
    });
  });

  it('lists the complete curated recommendation set in uppercase', async () => {
    tx.fancyNumber.findMany.mockResolvedValue([
      {
        id: 'fancy-rec',
        value: 'ab12c3',
        status: 'LEASED',
        source: 'ADMIN',
        isRecommended: true,
        sortOrder: 4,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    await expect(service.adminListRecommendations()).resolves.toEqual({
      items: [
        {
          id: 'fancy-rec',
          value: 'AB12C3',
          status: 'LEASED',
          source: 'ADMIN',
          isRecommended: true,
          sortOrder: 4,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
    expect(tx.fancyNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isRecommended: true },
        take: 101,
      }),
    );
  });

  it('atomically appends new and existing recommendations in request order', async () => {
    tx.fancyNumber.findMany
      .mockResolvedValueOnce([
        {
          id: 'existing-fancy',
          value: 'ab12c3',
          isRecommended: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'existing-fancy',
          value: 'ab12c3',
          status: 'AVAILABLE',
          source: 'CUSTOM',
          isRecommended: true,
          sortOrder: 5,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'new-fancy',
          value: 'xy98z7',
          status: 'AVAILABLE',
          source: 'ADMIN',
          isRecommended: true,
          sortOrder: 6,
          createdAt: now,
          updatedAt: now,
        },
      ]);
    tx.accountIdentifier.findMany.mockResolvedValue([{ value: 'ab12c3' }]);
    tx.fancyNumber.count.mockResolvedValue(0);
    tx.fancyNumber.findFirst.mockResolvedValue({ sortOrder: 4 });
    tx.accountIdentifier.createMany.mockResolvedValue({ count: 1 });
    tx.fancyNumber.createMany.mockResolvedValue({ count: 1 });
    tx.fancyNumber.update.mockResolvedValue({
      id: 'existing-fancy',
      value: 'ab12c3',
    });

    const result = await service.adminAddRecommendations('admin-1', [
      'AB12C3',
      'XY98Z7',
    ]);

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.accountIdentifier.createMany).toHaveBeenCalledWith({
      data: [{ value: 'xy98z7' }],
    });
    expect(tx.fancyNumber.update).toHaveBeenCalledWith({
      where: { id: 'existing-fancy' },
      data: { isRecommended: true, sortOrder: 5 },
    });
    expect(tx.fancyNumber.createMany).toHaveBeenCalledWith({
      data: [
        {
          value: 'xy98z7',
          source: 'ADMIN',
          status: 'AVAILABLE',
          createdByUserID: 'admin-1',
          isRecommended: true,
          sortOrder: 6,
        },
      ],
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorID: 'admin-1',
        action: 'FANCY_NUMBER_RECOMMENDATIONS_ADDED',
        entityType: 'FancyNumberRecommendation',
      }),
    });
    expect(result.items.map((item) => item.value)).toEqual([
      'AB12C3',
      'XY98Z7',
    ]);
  });

  it('removes a recommendation without disabling the fancy number', async () => {
    tx.fancyNumber.findUnique.mockResolvedValue({
      id: 'fancy-rec',
      value: 'ab12c3',
      status: 'AVAILABLE',
      source: 'ADMIN',
      isRecommended: true,
      sortOrder: 2,
      createdAt: now,
      updatedAt: now,
    });
    tx.fancyNumber.update.mockResolvedValue({
      id: 'fancy-rec',
      value: 'ab12c3',
      status: 'AVAILABLE',
      source: 'ADMIN',
      isRecommended: false,
      sortOrder: 2,
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      service.adminSetRecommendation('admin-1', 'fancy-rec', false),
    ).resolves.toMatchObject({
      value: 'AB12C3',
      status: 'AVAILABLE',
      isRecommended: false,
    });
    expect(tx.fancyNumber.update).toHaveBeenCalledWith({
      where: { id: 'fancy-rec' },
      data: { isRecommended: false },
      select: expect.any(Object),
    });
  });

  it('rejects a stale recommendation reorder before writing positions', async () => {
    tx.fancyNumber.findMany.mockResolvedValue([
      { id: 'current-a' },
      { id: 'current-b' },
    ]);

    await expect(
      service.adminReorderRecommendations(
        'admin-1',
        ['stale-a', 'current-b'],
        ['current-b', 'stale-a'],
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_RECOMMENDATION_CONFLICT',
      }),
    });
    expect(tx.fancyNumber.update).not.toHaveBeenCalled();
    expect(tx.adminAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects recommending an identifier occupied outside fancy-number inventory', async () => {
    tx.fancyNumber.findMany.mockResolvedValue([]);
    tx.accountIdentifier.findMany.mockResolvedValue([{ value: 'ab12c3' }]);

    await expect(
      service.adminAddRecommendations('admin-1', ['AB12C3']),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_RECOMMENDATION_ACCOUNT_OCCUPIED',
      }),
    });
    expect(tx.accountIdentifier.createMany).not.toHaveBeenCalled();
    expect(tx.fancyNumber.createMany).not.toHaveBeenCalled();
  });

  it('enforces the recommendation cap while holding the shared lock', async () => {
    tx.fancyNumber.findMany.mockResolvedValue([
      {
        id: 'existing-fancy',
        value: 'ab12c3',
        isRecommended: false,
      },
    ]);
    tx.accountIdentifier.findMany.mockResolvedValue([{ value: 'ab12c3' }]);
    tx.fancyNumber.count.mockResolvedValue(100);

    await expect(
      service.adminAddRecommendations('admin-1', ['AB12C3']),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_RECOMMENDATION_LIMIT',
      }),
    });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.fancyNumber.update).not.toHaveBeenCalled();
  });

  it('reorders the exact recommendation snapshot and audits before and after', async () => {
    tx.fancyNumber.findMany
      .mockResolvedValueOnce([{ id: 'fancy-a' }, { id: 'fancy-b' }])
      .mockResolvedValueOnce([
        {
          id: 'fancy-b',
          value: 'xy98z7',
          status: 'AVAILABLE',
          source: 'ADMIN',
          isRecommended: true,
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'fancy-a',
          value: 'ab12c3',
          status: 'AVAILABLE',
          source: 'ADMIN',
          isRecommended: true,
          sortOrder: 1,
          createdAt: now,
          updatedAt: now,
        },
      ]);

    const result = await service.adminReorderRecommendations(
      'admin-1',
      ['fancy-a', 'fancy-b'],
      ['fancy-b', 'fancy-a'],
    );

    expect(tx.fancyNumber.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'fancy-b' },
      data: { sortOrder: 0 },
    });
    expect(tx.fancyNumber.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'fancy-a' },
      data: { sortOrder: 1 },
    });
    expect(tx.adminAuditLog.create).toHaveBeenCalledWith({
      data: {
        actorID: 'admin-1',
        action: 'FANCY_NUMBER_RECOMMENDATIONS_REORDERED',
        entityType: 'FancyNumberRecommendation',
        before: { ids: ['fancy-a', 'fancy-b'] },
        after: { ids: ['fancy-b', 'fancy-a'] },
      },
    });
    expect(result.items.map((item) => item.id)).toEqual(['fancy-b', 'fancy-a']);
  });

  it('lists available numbers with permanent-free mode for a super member', async () => {
    tx.user.findUnique.mockResolvedValue({
      vipLevel: 4,
      vipExpiresAt: null,
    });
    tx.fancyNumber.findMany.mockResolvedValue([
      { id: 'fancy-a', value: '666666' },
      { id: 'fancy-b', value: '888888' },
    ]);

    await expect(
      service.listAvailable(
        'super-2',
        { limit: 1 },
        new Date('2026-07-28T00:00:00.000Z'),
      ),
    ).resolves.toEqual({
      items: [{ id: 'fancy-a', value: '666666' }],
      nextCursor: 'fancy-a',
      unitPrice: 100,
      minMonths: 1,
      maxMonths: 12,
      purchaseMode: 'PERMANENT_FREE',
    });
    expect(tx.fancyNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: 'AVAILABLE', isRecommended: true },
      }),
    );
  });

  it('displays custom recommendations and the active custom fancy number in uppercase', async () => {
    tx.user.findUnique.mockResolvedValue({
      vipLevel: 0,
      vipExpiresAt: null,
    });
    tx.fancyNumber.findMany.mockResolvedValue([
      { id: 'fancy-custom', value: 'ab12c3', source: 'CUSTOM' },
    ]);

    await expect(
      service.listAvailable('user-custom', { limit: 20 }, now),
    ).resolves.toMatchObject({
      items: [{ id: 'fancy-custom', value: 'AB12C3' }],
    });

    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-custom',
      restoreAccountId: 'normal01',
      startedAt: now,
      expiresAt: null,
      permanentAt: now,
      fancyNumber: { value: 'ab12c3', source: 'CUSTOM' },
    });
    await expect(service.getMine('user-custom', now)).resolves.toMatchObject({
      active: true,
      accountId: 'AB12C3',
      permanent: true,
    });
  });

  it('returns a stable inactive state when the user has no fancy number', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue(null);

    await expect(service.getMine('user-5')).resolves.toEqual({
      active: false,
      accountId: null,
      restoreAccountId: null,
      startedAt: null,
      expiresAt: null,
      permanent: false,
      renewable: false,
      unitPrice: 100,
    });
  });

  it('blocks an account-id change while a paid fancy-number lease is active', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-active',
      permanentAt: null,
      expiresAt: new Date('2026-08-28T00:00:00.000Z'),
    });

    await expect(
      service.ensureAccountIdChangeAllowed(
        'user-6',
        new Date('2026-07-28T00:00:00.000Z'),
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: 'FANCY_NUMBER_ACCOUNT_ID_LOCKED',
      }),
    });
  });

  it('expires an overdue lease before allowing an account-id change', async () => {
    const expiresAt = new Date('2026-07-27T00:00:00.000Z');
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-overdue',
      permanentAt: null,
      expiresAt,
    });
    const expireSpy = jest
      .spyOn(service, 'expireLease')
      .mockResolvedValue(true);

    await expect(
      service.ensureAccountIdChangeAllowed(
        'user-7',
        new Date('2026-07-28T00:00:00.000Z'),
      ),
    ).resolves.toBeUndefined();
    expect(expireSpy).toHaveBeenCalledWith(
      'lease-overdue',
      new Date('2026-07-28T00:00:00.000Z'),
    );
  });

  it('converts an active paid lease to permanent inside the membership transaction', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-paid',
      userID: 'user-super',
      fancyNumberID: 'fancy-paid',
      expiresAt: new Date('2026-08-28T00:00:00.000Z'),
      permanentAt: null,
    });
    tx.fancyNumberLease.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.convertActiveLeaseToPermanent(
        tx as never,
        'user-super',
        new Date('2026-07-28T00:00:00.000Z'),
      ),
    ).resolves.toBe(true);

    expect(tx.fancyNumberLease.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'lease-paid',
        endedAt: null,
        permanentAt: null,
        expiresAt: { gt: new Date('2026-07-28T00:00:00.000Z') },
      },
      data: {
        expiresAt: null,
        permanentAt: new Date('2026-07-28T00:00:00.000Z'),
      },
    });
    expect(tx.fancyNumber.update).toHaveBeenCalledWith({
      where: { id: 'fancy-paid' },
      data: { status: 'PERMANENT', disabledAt: null },
    });
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-super' },
      data: {
        fancyNumber: true,
        fancyNumberExpiresAt: null,
        fancyNumberPermanent: true,
      },
    });
    expect(tx.fancyNumberOrder.upsert).toHaveBeenCalledWith({
      where: { idempotencyKey: 'super-conversion:lease-paid' },
      update: {},
      create: {
        idempotencyKey: 'super-conversion:lease-paid',
        requestFingerprint: 'super-conversion:lease-paid',
        type: 'SUPER_CONVERSION',
        userID: 'user-super',
        fancyNumberID: 'fancy-paid',
        leaseID: 'lease-paid',
        months: null,
        unitPrice: 0,
        totalPrice: 0,
        walletBalanceAfter: null,
        previousExpiresAt: new Date('2026-08-28T00:00:00.000Z'),
        newExpiresAt: null,
      },
    });
  });

  it('restores an expired lease instead of making it permanent during a super upgrade', async () => {
    tx.fancyNumberLease.findFirst.mockResolvedValue({
      id: 'lease-expired-upgrade',
      userID: 'user-upgrade',
      fancyNumberID: 'fancy-expired-upgrade',
      restoreAccountId: 'normal88',
      expiresAt: new Date('2026-07-27T00:00:00.000Z'),
      permanentAt: null,
      user: { accountId: '888888' },
      fancyNumber: { value: '888888' },
    });
    tx.fancyNumberLease.updateMany.mockResolvedValue({ count: 1 });
    tx.accountIdentifier.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(
      service.convertActiveLeaseToPermanent(
        tx as never,
        'user-upgrade',
        new Date('2026-07-28T00:00:00.000Z'),
      ),
    ).resolves.toBe(false);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-upgrade' },
      data: {
        accountId: 'normal88',
        fancyNumber: false,
        fancyNumberExpiresAt: null,
        fancyNumberPermanent: false,
      },
    });
    expect(tx.fancyNumber.updateMany).toHaveBeenCalledWith({
      where: { id: 'fancy-expired-upgrade', status: 'LEASED' },
      data: { status: 'AVAILABLE', disabledAt: null },
    });
    expect(tx.fancyNumberOrder.upsert).not.toHaveBeenCalled();
  });
});
