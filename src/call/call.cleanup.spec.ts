import { CallCleanup } from './call.cleanup';

describe('CallCleanup', () => {
  it('sweeps expired ringing calls through CallService', async () => {
    const service = {
      sweepExpiredRingingCalls: jest.fn().mockResolvedValue(2),
    };
    const cleanup = new CallCleanup(service as any);

    await cleanup.sweepExpiredRingingCalls();

    expect(service.sweepExpiredRingingCalls).toHaveBeenCalled();
  });

  it('does not throw when cleanup fails', async () => {
    const service = {
      sweepExpiredRingingCalls: jest
        .fn()
        .mockRejectedValue(new Error('db down')),
    };
    const cleanup = new CallCleanup(service as any);

    await expect(cleanup.sweepExpiredRingingCalls()).resolves.toBeUndefined();
  });
});
