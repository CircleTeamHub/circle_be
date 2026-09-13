import { BadRequestException } from '@nestjs/common';
import { CoinController } from './coin.controller';
import { CoinService } from './coin.service';

describe('CoinController', () => {
  const service = {
    getWallet: jest.fn(),
    getTransactions: jest.fn(),
    sendGift: jest.fn(),
  };
  const controller = new CoinController(service as unknown as CoinService);
  const request = { user: { userId: 'user-1' } } as never;
  const dto = { recipientId: 'recipient-1', amount: 100 };

  beforeEach(() => jest.clearAllMocks());

  it('passes the trimmed idempotency key through to the service', async () => {
    service.sendGift.mockResolvedValue(undefined);

    await controller.sendGift(dto, ' key-1 ', request);

    expect(service.sendGift).toHaveBeenCalledWith(
      'user-1',
      'recipient-1',
      100,
      'key-1',
      undefined,
    );
  });

  it('rejects a missing idempotency key before reaching the service', () => {
    expect(() => controller.sendGift(dto, '   ', request)).toThrow(
      BadRequestException,
    );
    expect(service.sendGift).not.toHaveBeenCalled();
  });

  // 键直接落库当唯一索引;不封顶等于让客户端决定索引行宽。与 fancy-number 同上限。
  it('rejects an idempotency key longer than 128 characters', () => {
    expect(() => controller.sendGift(dto, 'k'.repeat(129), request)).toThrow(
      BadRequestException,
    );
    expect(service.sendGift).not.toHaveBeenCalled();
  });

  it('accepts an idempotency key of exactly 128 characters', async () => {
    service.sendGift.mockResolvedValue(undefined);

    await controller.sendGift(dto, 'k'.repeat(128), request);

    expect(service.sendGift).toHaveBeenCalledWith(
      'user-1',
      'recipient-1',
      100,
      'k'.repeat(128),
      undefined,
    );
  });
});
