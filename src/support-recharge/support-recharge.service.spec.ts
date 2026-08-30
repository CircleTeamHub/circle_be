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
});
