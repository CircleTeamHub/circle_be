import { FancyNumberCleanup } from './fancy-number.cleanup';
import { FancyNumberService } from './fancy-number.service';

describe('FancyNumberCleanup', () => {
  it('delegates the scheduled expiry sweep to the service', async () => {
    const service = { expireDue: jest.fn().mockResolvedValue(2) };
    const cleanup = new FancyNumberCleanup(
      service as unknown as FancyNumberService,
    );

    await cleanup.sweepExpiredLeases();

    expect(service.expireDue).toHaveBeenCalledTimes(1);
  });
});
