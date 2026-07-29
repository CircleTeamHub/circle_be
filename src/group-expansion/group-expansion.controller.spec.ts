import { BadRequestException } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { GroupExpansionController } from './group-expansion.controller';
import { GroupExpansionService } from './group-expansion.service';

describe('GroupExpansionController', () => {
  const service = {
    getProducts: jest.fn(),
    purchase: jest.fn(),
    getOrders: jest.fn(),
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
      },
      ' request-1 ',
      request,
    );

    expect(service.purchase).toHaveBeenCalledWith(
      'user-1',
      '54a43f3e-4df0-4d58-bcec-952214502ee4',
      'light',
      'request-1',
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

  it('passes pagination inputs to owner order history', async () => {
    service.getOrders.mockResolvedValue({ items: [], nextCursor: null });

    await controller.getOrders(
      {
        circleId: '54a43f3e-4df0-4d58-bcec-952214502ee4',
        cursor: 'order-1',
        limit: 10,
      },
      request,
    );

    expect(service.getOrders).toHaveBeenCalledWith(
      'user-1',
      '54a43f3e-4df0-4d58-bcec-952214502ee4',
      'order-1',
      10,
    );
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
