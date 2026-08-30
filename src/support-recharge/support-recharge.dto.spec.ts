import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  ApproveSupportRechargeOrderDto,
  CreateSupportRechargePaymentCodeDto,
  SetSupportRechargePaymentCodeEnabledDto,
} from './support-recharge.dto';

const transformOptions = { enableImplicitConversion: true };

function errorsFor<T extends object>(type: new () => T, payload: unknown) {
  return validateSync(plainToInstance(type, payload, transformOptions), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('support recharge DTOs', () => {
  it('requires the fulfillment fields that match the selected benefit', () => {
    expect(
      errorsFor(ApproveSupportRechargeOrderDto, {
        fulfillmentType: 'COIN',
        paymentTransactionId: 'trade-1',
      }),
    ).not.toHaveLength(0);
    expect(
      errorsFor(ApproveSupportRechargeOrderDto, {
        fulfillmentType: 'COIN',
        paymentTransactionId: 'trade-1',
        coinAmount: 100,
      }),
    ).toHaveLength(0);
  });

  it('rejects string booleans instead of enabling a payment code by coercion', () => {
    expect(
      errorsFor(SetSupportRechargePaymentCodeEnabledDto, { enabled: false }),
    ).toHaveLength(0);
    expect(
      errorsFor(SetSupportRechargePaymentCodeEnabledDto, { enabled: 'false' }),
    ).not.toHaveLength(0);
  });

  it('only accepts uploaded chat object keys and valid timestamps', () => {
    const valid = {
      label: '支付宝',
      objectKey:
        'chat/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.png',
      validFrom: '2026-08-29T00:00:00.000Z',
    };
    expect(errorsFor(CreateSupportRechargePaymentCodeDto, valid)).toHaveLength(
      0,
    );
    expect(
      errorsFor(CreateSupportRechargePaymentCodeDto, {
        ...valid,
        objectKey: 'avatar/private-code.png',
      }),
    ).not.toHaveLength(0);
  });
});
