import { CallCleanup } from './call.cleanup';
import * as errorAggregation from '../logging/error-aggregation.service';

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

    const report = jest
      .spyOn(errorAggregation, 'reportOperationalError')
      .mockImplementation(() => undefined);

    await expect(cleanup.sweepExpiredRingingCalls()).resolves.toBeUndefined();
    expect(report).toHaveBeenCalledWith(expect.any(Error), {
      component: 'CallCleanup',
      operation: 'sweepExpiredRingingCalls',
      kind: 'scheduler',
    });
    report.mockRestore();
  });
});
