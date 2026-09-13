import { SupportRechargeService } from './support-recharge.service';

describe('SupportRechargeService approval replay', () => {
  const service = new SupportRechargeService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('compares stored JSON by fields instead of JSON property order', () => {
    const assertSameApproval = (
      service as unknown as {
        assertSameApproval: (order: unknown, input: unknown) => void;
      }
    ).assertSameApproval.bind(service);

    expect(() =>
      assertSameApproval(
        {
          fulfillmentType: 'COIN',
          paymentTransactionID: 'trade-1',
          fulfillmentPayload: {
            note: null,
            coinAmount: 100,
            paymentTransactionId: 'trade-1',
            fulfillmentType: 'COIN',
          },
        },
        {
          fulfillmentType: 'COIN',
          paymentTransactionId: 'trade-1',
          coinAmount: 100,
          note: null,
        },
      ),
    ).not.toThrow();
  });

  it('rejects a replay that changes the benefit amount', () => {
    const assertSameApproval = (
      service as unknown as {
        assertSameApproval: (order: unknown, input: unknown) => void;
      }
    ).assertSameApproval.bind(service);

    expect(() =>
      assertSameApproval(
        {
          fulfillmentType: 'COIN',
          paymentTransactionID: 'trade-1',
          fulfillmentPayload: {
            fulfillmentType: 'COIN',
            paymentTransactionId: 'trade-1',
            coinAmount: 100,
            note: null,
          },
        },
        {
          fulfillmentType: 'COIN',
          paymentTransactionId: 'trade-1',
          coinAmount: 200,
          note: null,
        },
      ),
    ).toThrow('该充值申请已经使用不同的发放参数处理');
  });
});

describe('SupportRechargeService payment-code updates', () => {
  it('replaces the image while preserving omitted validity fields', async () => {
    const before = {
      id: 'code-1',
      label: '旧收款码',
      objectKey: 'chat/admin-1/old.png',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: new Date('2026-09-01T00:00:00.000Z'),
      enabled: true,
    };
    const update = jest.fn().mockImplementation(({ data }) => ({
      ...before,
      ...data,
    }));
    const tx = {
      supportRechargePaymentCode: {
        findUnique: jest.fn().mockResolvedValue(before),
        update,
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
    };
    const audit = { recordInTransaction: jest.fn() };
    const upload = {
      createPresignedGetUrl: jest
        .fn()
        .mockResolvedValue({ url: 'https://example.test/new.png' }),
    };
    const service = new SupportRechargeService(
      prisma as never,
      audit as never,
      upload as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.updatePaymentCode(
      { userId: 'admin-1', accountId: 'admin' },
      'code-1',
      {
        label: '新收款码',
        objectKey: 'chat/admin-1/new.png',
      },
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: 'code-1' },
      data: {
        label: '新收款码',
        objectKey: 'chat/admin-1/new.png',
        validFrom: before.validFrom,
        validUntil: before.validUntil,
      },
    });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'support.recharge.payment_code.update',
        targetId: 'code-1',
      }),
    );
  });

  it('disables older codes before creating the new current code', async () => {
    const created = {
      id: 'code-new',
      label: '新收款码',
      objectKey: 'chat/admin-1/new.png',
      validFrom: new Date('2026-08-29T00:00:00.000Z'),
      validUntil: null,
      enabled: true,
    };
    const tx = {
      supportRechargePaymentCode: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        create: jest.fn().mockResolvedValue(created),
      },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const audit = { recordInTransaction: jest.fn() };
    const upload = {
      createPresignedGetUrl: jest
        .fn()
        .mockResolvedValue({ url: 'https://example.test/new.png' }),
    };
    const service = new SupportRechargeService(
      prisma as never,
      audit as never,
      upload as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.createPaymentCode(
      { userId: 'admin-1', accountId: 'admin' },
      {
        label: '新收款码',
        objectKey: 'chat/admin-1/new.png',
        validFrom: '2020-08-29T00:00:00.000Z',
      },
    );

    expect(tx.supportRechargePaymentCode.updateMany).toHaveBeenCalledWith({
      where: {
        enabled: true,
        validFrom: { lte: expect.any(Date) },
        OR: [{ validUntil: null }, { validUntil: { gt: expect.any(Date) } }],
      },
      data: { enabled: false },
    });
    expect(tx.supportRechargePaymentCode.create).toHaveBeenCalled();
  });
});

describe('SupportRechargeService order pagination', () => {
  it('continues after the last id with a stable createdAt/id order', async () => {
    const prisma = {
      supportRechargeOrder: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new SupportRechargeService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.listOrders({
      limit: 50,
      cursor: '11111111-1111-4111-8111-111111111111',
    });

    expect(prisma.supportRechargeOrder.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        cursor: { id: '11111111-1111-4111-8111-111111111111' },
        skip: 1,
        take: 50,
      }),
    );
  });
});

// 管理台把 ApproveSupportRechargeOrderDto.note 标成「审核备注」，MEMBERSHIP 分支只把它
// 写进 MembershipGrant.note（仅管理员可见）；COIN 分支却曾原样写进用户可读的
// CoinTransaction.note（GET /coin/transactions）。流水固定用单号，备注只进审计。
describe('SupportRechargeService coin fulfillment note', () => {
  const operator = { userId: 'admin-1', accountId: 'admin' };
  const input = {
    fulfillmentType: 'COIN' as const,
    paymentTransactionId: 'pay-1',
    coinAmount: 100,
    note: 'internal remark',
  };
  const order = {
    id: 'order-1',
    orderNo: 'SR-20260913-0001',
    conversationID: 'conv-1',
    userID: 'user-1',
    agentUserID: 'agent-1',
    requestKind: 'COIN',
    status: 'PROCESSING',
    evidenceMessageID: null,
    evidenceObjectKey: null,
    submittedAt: new Date('2026-09-13T00:00:00.000Z'),
    fulfillmentType: 'COIN',
    fulfillmentPayload: { ...input },
    paymentTransactionID: 'pay-1',
    reviewedBy: 'admin-1',
    reviewedAt: null,
    rejectionReason: null,
    createdAt: new Date('2026-09-13T00:00:00.000Z'),
    updatedAt: new Date('2026-09-13T00:00:00.000Z'),
  };

  it('keeps the admin review note out of the user-visible ledger and records it in the audit trail', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      supportRechargeOrder: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockResolvedValue({
          ...order,
          status: 'APPROVED',
          reviewedAt: new Date('2026-09-13T01:00:00.000Z'),
        }),
      },
      coinTransaction: { findUnique: jest.fn().mockResolvedValue(null) },
      supportRechargeConversationState: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = { $transaction: jest.fn((callback) => callback(tx)) };
    const audit = { recordInTransaction: jest.fn() };
    const coins = { creditInTransaction: jest.fn().mockResolvedValue(1100) };
    const service = new SupportRechargeService(
      prisma as never,
      audit as never,
      {} as never,
      {} as never,
      coins as never,
      {} as never,
      {} as never,
    );

    await (service as any).fulfillCoins(operator, order, input);

    expect(coins.creditInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        userId: 'user-1',
        amount: 100,
        type: 'RECHARGE',
        note: '充值申请 SR-20260913-0001',
        idempotencyKey: 'order-1',
      }),
    );
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'support.recharge.order.approve',
        targetId: 'order-1',
        metadata: { fulfillmentType: 'COIN', note: 'internal remark' },
      }),
    );
  });
});

// list / approve 都经 presentOrders 剥掉私有对象键、换成 15 分钟预签名 URL；
// reject 曾直接回原始行，把 evidenceObjectKey 交给管理台，形状也与其它两条不一致。
describe('SupportRechargeService rejectOrder response shape', () => {
  it('returns the presented order without the private evidence object key', async () => {
    const before = {
      id: 'order-1',
      orderNo: 'SR-20260913-0002',
      conversationID: 'conv-1',
      userID: 'user-1',
      agentUserID: 'agent-1',
      requestKind: 'COIN',
      status: 'PENDING',
      evidenceMessageID: 'msg-1',
      evidenceObjectKey: 'chat/user-1/evidence.png',
      submittedAt: new Date('2026-09-13T00:00:00.000Z'),
      fulfillmentType: null,
      fulfillmentPayload: null,
      paymentTransactionID: null,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt: new Date('2026-09-13T00:00:00.000Z'),
      updatedAt: new Date('2026-09-13T00:00:00.000Z'),
    };
    const after = {
      ...before,
      status: 'REJECTED',
      rejectionReason: 'no matching payment',
      reviewedBy: 'admin-1',
      reviewedAt: new Date('2026-09-13T01:00:00.000Z'),
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      supportRechargeOrder: {
        findUnique: jest.fn().mockResolvedValue(before),
        update: jest.fn().mockResolvedValue(after),
      },
      supportRechargeConversationState: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
      supportRechargeOrder: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(after),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'user-1', accountId: 'u1', nickname: 'User' },
          { id: 'agent-1', accountId: 'a1', nickname: 'Agent' },
        ]),
      },
    };
    const audit = { recordInTransaction: jest.fn() };
    const upload = {
      createPresignedGetUrl: jest
        .fn()
        .mockResolvedValue({ url: 'https://example.test/evidence.png' }),
    };
    const messages = { insertServerMessage: jest.fn().mockResolvedValue(null) };
    const service = new SupportRechargeService(
      prisma as never,
      audit as never,
      upload as never,
      messages as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const result = await service.rejectOrder(
      { userId: 'admin-1', accountId: 'admin' },
      'order-1',
      'no matching payment',
    );

    expect(result).not.toHaveProperty('evidenceObjectKey');
    expect(result).toMatchObject({
      id: 'order-1',
      status: 'REJECTED',
      rejectionReason: 'no matching payment',
      evidenceUrl: 'https://example.test/evidence.png',
      user: { id: 'user-1', accountId: 'u1', nickname: 'User' },
    });
    expect(result).not.toHaveProperty('agent');
    expect(messages.insertServerMessage).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({ clientMessageId: 'sr-order-1-rejected' }),
    );
  });
});

// 管理台（circle_admin_web api/support-recharge.ts + SupportRechargePage）实际读取的列：
// 收款码不读 createdBy（管理员 userId，属于审计信息）；申请单不读 conversationID /
// evidenceMessageID / updatedAt，也不读 agent（列表只渲染 user）。响应按列显式映射。
describe('SupportRechargeService admin response contract', () => {
  const operator = { userId: 'admin-1', accountId: 'admin' };
  const upload = {
    createPresignedGetUrl: jest
      .fn()
      .mockResolvedValue({ url: 'https://example.test/signed.png' }),
  };
  const buildService = (prisma: unknown) =>
    new SupportRechargeService(
      prisma as never,
      { recordInTransaction: jest.fn() } as never,
      upload as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

  it('returns payment codes without createdBy on every read/write path', async () => {
    const row = {
      id: 'code-1',
      label: '收款码',
      objectKey: 'chat/admin-1/code.png',
      validFrom: new Date('2026-08-01T00:00:00.000Z'),
      validUntil: null,
      enabled: true,
      createdBy: 'admin-1',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-02T00:00:00.000Z'),
    };
    const presented = {
      id: 'code-1',
      label: '收款码',
      objectKey: 'chat/admin-1/code.png',
      validFrom: row.validFrom,
      validUntil: null,
      enabled: true,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      previewUrl: 'https://example.test/signed.png',
    };
    const tx = {
      supportRechargePaymentCode: {
        findUnique: jest.fn().mockResolvedValue(row),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
    };
    const prisma = {
      $transaction: jest.fn((callback) => callback(tx)),
      supportRechargePaymentCode: {
        findMany: jest.fn().mockResolvedValue([row]),
      },
    };
    const service = buildService(prisma);

    await expect(service.listPaymentCodes()).resolves.toEqual([presented]);
    await expect(
      service.createPaymentCode(operator, {
        label: '收款码',
        objectKey: 'chat/admin-1/code.png',
        validFrom: '2026-08-01T00:00:00.000Z',
      }),
    ).resolves.toEqual(presented);
    await expect(
      service.updatePaymentCode(operator, 'code-1', { label: '收款码' }),
    ).resolves.toEqual(presented);
    await expect(
      service.setPaymentCodeEnabled(operator, 'code-1', true),
    ).resolves.toEqual(presented);
  });

  it('presents orders without conversation/evidence-message ids, updatedAt or an agent join', async () => {
    const createdAt = new Date('2026-09-13T00:00:00.000Z');
    const row = {
      id: 'order-1',
      orderNo: 'SR-20260913-0003',
      conversationID: 'conv-1',
      userID: 'user-1',
      agentUserID: 'agent-1',
      requestKind: 'COIN',
      status: 'WAITING_REVIEW',
      evidenceMessageID: 'msg-1',
      evidenceObjectKey: 'chat/user-1/evidence.png',
      submittedAt: createdAt,
      fulfillmentType: null,
      fulfillmentPayload: null,
      paymentTransactionID: null,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt,
      updatedAt: createdAt,
    };
    const prisma = {
      supportRechargeOrder: { findMany: jest.fn().mockResolvedValue([row]) },
      user: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: 'user-1', accountId: 'u1', nickname: 'User' }]),
      },
    };
    const service = buildService(prisma);

    const [order] = await service.listOrders({ limit: 20 });

    const { select } = prisma.supportRechargeOrder.findMany.mock.calls[0][0];
    for (const column of ['conversationID', 'evidenceMessageID', 'updatedAt']) {
      expect(select).not.toHaveProperty(column);
    }
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['user-1'] } },
      select: { id: true, accountId: true, nickname: true },
    });
    expect(order).toEqual({
      id: 'order-1',
      orderNo: 'SR-20260913-0003',
      userID: 'user-1',
      agentUserID: 'agent-1',
      requestKind: 'COIN',
      status: 'WAITING_REVIEW',
      submittedAt: createdAt,
      fulfillmentType: null,
      fulfillmentPayload: null,
      paymentTransactionID: null,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      createdAt,
      user: { id: 'user-1', accountId: 'u1', nickname: 'User' },
      evidenceUrl: 'https://example.test/signed.png',
    });
  });
});
