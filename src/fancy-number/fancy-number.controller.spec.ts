import { BadRequestException } from '@nestjs/common';
import { FancyNumberController } from './fancy-number.controller';
import { FancyNumberService } from './fancy-number.service';

describe('FancyNumberController', () => {
  const service = {
    listAvailable: jest.fn(),
    getMine: jest.fn(),
    checkCustomAvailability: jest.fn(),
    purchase: jest.fn(),
    purchaseCustom: jest.fn(),
    renew: jest.fn(),
    switchPermanent: jest.fn(),
    switchPermanentCustom: jest.fn(),
  };
  const controller = new FancyNumberController(
    service as unknown as FancyNumberService,
  );
  const request = { user: { userId: 'user-1' } } as never;

  beforeEach(() => jest.clearAllMocks());

  it('passes the authenticated user and idempotency key to purchase', async () => {
    service.purchase.mockResolvedValue({ orderId: 'order-1' });

    await controller.purchase('fancy-1', { months: 2 }, ' request-1 ', request);

    expect(service.purchase).toHaveBeenCalledWith(
      'user-1',
      'fancy-1',
      2,
      'request-1',
    );
  });

  it('checks and purchases a normalized custom fancy number', async () => {
    service.checkCustomAvailability.mockResolvedValue({ available: true });
    service.purchaseCustom.mockResolvedValue({ orderId: 'order-custom' });

    await controller.checkCustomAvailability({ value: 'AB12C3' }, request);
    await controller.purchaseCustom(
      { value: 'AB12C3', months: 2 },
      ' custom-request ',
      request,
    );

    expect(service.checkCustomAvailability).toHaveBeenCalledWith(
      'user-1',
      'AB12C3',
    );
    expect(service.purchaseCustom).toHaveBeenCalledWith(
      'user-1',
      'AB12C3',
      2,
      'custom-request',
    );
  });

  it('rejects a missing idempotency key before renewal reaches the service', () => {
    expect(() => controller.renew({ months: 1 }, undefined, request)).toThrow(
      BadRequestException,
    );
    expect(service.renew).not.toHaveBeenCalled();
  });

  it('passes the authenticated user and idempotency key to permanent-number switching', async () => {
    service.switchPermanent.mockResolvedValue({ orderId: 'order-switch' });

    await controller.switchPermanent('fancy-new', ' switch-request ', request);

    expect(service.switchPermanent).toHaveBeenCalledWith(
      'user-1',
      'fancy-new',
      'switch-request',
    );
  });

  it('switches a permanent number to a normalized custom value', async () => {
    service.switchPermanentCustom.mockResolvedValue({
      orderId: 'order-custom-switch',
    });

    await controller.switchPermanentCustom(
      { value: 'AB12C3' },
      ' custom-switch-request ',
      request,
    );

    expect(service.switchPermanentCustom).toHaveBeenCalledWith(
      'user-1',
      'AB12C3',
      'custom-switch-request',
    );
  });
});
