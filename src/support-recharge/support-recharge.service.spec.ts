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
