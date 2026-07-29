import { FancyNumberAdminController } from './fancy-number-admin.controller';
import { FancyNumberService } from './fancy-number.service';

describe('FancyNumberAdminController', () => {
  const service = {
    adminList: jest.fn(),
    adminBatchCreate: jest.fn(),
    adminSetAvailability: jest.fn(),
    adminListRecommendations: jest.fn(),
    adminAddRecommendations: jest.fn(),
    adminSetRecommendation: jest.fn(),
    adminReorderRecommendations: jest.fn(),
  };
  const controller = new FancyNumberAdminController(
    service as unknown as FancyNumberService,
  );
  const request = { user: { userId: 'admin-1' } } as never;

  beforeEach(() => jest.clearAllMocks());

  it('uses the authenticated admin as the inventory creator', async () => {
    service.adminBatchCreate.mockResolvedValue([]);

    await controller.batchCreate({ values: ['888888'] }, request);

    expect(service.adminBatchCreate).toHaveBeenCalledWith('admin-1', [
      '888888',
    ]);
  });

  it('delegates availability changes with the admin actor', async () => {
    service.adminSetAvailability.mockResolvedValue({ id: 'fancy-1' });

    await controller.setAvailability('fancy-1', { enabled: false }, request);

    expect(service.adminSetAvailability).toHaveBeenCalledWith(
      'admin-1',
      'fancy-1',
      false,
    );
  });

  it('delegates recommendation mutations with the authenticated admin', async () => {
    service.adminAddRecommendations.mockResolvedValue({ items: [] });
    service.adminSetRecommendation.mockResolvedValue({ id: 'fancy-1' });
    service.adminReorderRecommendations.mockResolvedValue({ items: [] });

    await controller.addRecommendations({ values: ['AB12C3'] }, request);
    await controller.setRecommendation(
      'fancy-1',
      { recommended: false },
      request,
    );
    await controller.reorderRecommendations(
      { expectedIds: ['fancy-1'], ids: ['fancy-1'] },
      request,
    );

    expect(service.adminAddRecommendations).toHaveBeenCalledWith('admin-1', [
      'AB12C3',
    ]);
    expect(service.adminSetRecommendation).toHaveBeenCalledWith(
      'admin-1',
      'fancy-1',
      false,
    );
    expect(service.adminReorderRecommendations).toHaveBeenCalledWith(
      'admin-1',
      ['fancy-1'],
      ['fancy-1'],
    );
  });
});
