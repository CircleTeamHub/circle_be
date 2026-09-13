import { BadRequestException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { GroupExpansionController } from './group-expansion.controller';
import { GroupExpansionService } from './group-expansion.service';

describe('GroupExpansionController', () => {
  const service = {
    getProducts: jest.fn(),
    purchase: jest.fn(),
  };
  const controller = new GroupExpansionController(
    service as unknown as GroupExpansionService,
  );
  const request = { user: { userId: 'user-1' } } as never;

  beforeEach(() => jest.clearAllMocks());

  it('passes the authenticated owner and normalized idempotency key to purchase', async () => {
    service.purchase.mockResolvedValue({ orderId: 'order-1' });

    await controller.purchase(
      {
        circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4',
        productId: 'light',
        expectedPrice: 100,
        expectedSeats: 100,
      },
      ' request-1 ',
      request,
    );

    expect(service.purchase).toHaveBeenCalledWith(
      'user-1',
      '54a43f3e-4df0-4d58-bcec-952214502ee4',
      'light',
      'request-1',
      { price: 100, seats: 100 },
    );
  });

  it('rejects a missing idempotency key before calling the service', () => {
    const requireIdempotencyKey = (
      controller as unknown as {
        requireIdempotencyKey(value: string | undefined): string;
      }
    ).requireIdempotencyKey.bind(controller);
    let error: BadRequestException | undefined;
    try {
      requireIdempotencyKey(undefined);
    } catch (caught) {
      error = caught as BadRequestException;
    }

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error?.getResponse()).toMatchObject({
      errorCode: 'GROUP_EXPANSION_INVALID_IDEMPOTENCY_KEY',
    });
    expect(service.purchase).not.toHaveBeenCalled();
  });

  it('returns HTTP 200 for both initial purchases and idempotent replays', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        GroupExpansionController.prototype.purchase,
      ),
    ).toBe(200);
  });

  // GET /group-expansions/orders 没有任何客户端调用(circle-im 只用 products 与
  // purchases,管理台不涉及扩容卡)。连同 service.getOrders 与查询/响应 DTO 一起删掉。
  it('no longer exposes the owner order-history listing', () => {
    expect(
      (GroupExpansionController.prototype as unknown as Record<string, unknown>)
        .getOrders,
    ).toBeUndefined();
    expect(
      (GroupExpansionService.prototype as unknown as Record<string, unknown>)
        .getOrders,
    ).toBeUndefined();
  });

  it('passes the selected circle to product listing', async () => {
    service.getProducts.mockResolvedValue({ products: [] });

    await controller.getProducts(
      { circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4' },
      request,
    );

    expect(service.getProducts).toHaveBeenCalledWith(
      'user-1',
      '54a43f3e-4df0-4d58-bcec-952214502ee4',
    );
  });
});
