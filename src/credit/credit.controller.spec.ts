import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';

describe('CreditController', () => {
  const service = { getRecentEvents: jest.fn() };
  const controller = new CreditController(service as unknown as CreditService);

  beforeEach(() => jest.clearAllMocks());

  it('reads the events of the authenticated user, never a caller-supplied id', async () => {
    const events = [{ id: 'event-1' }];
    service.getRecentEvents.mockResolvedValue(events);

    await expect(
      controller.getEvents({ user: { userId: 'user-1' } } as never),
    ).resolves.toBe(events);
    expect(service.getRecentEvents).toHaveBeenCalledWith('user-1');
  });
});
