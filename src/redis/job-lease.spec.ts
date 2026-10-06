import { runWithJobLease } from './job-lease';

describe('runWithJobLease', () => {
  it('passes the acquired token to shared writes and releases it after failure', async () => {
    const redis = {
      tryAcquireLease: jest.fn().mockResolvedValue('owner-token'),
      releaseLease: jest.fn().mockResolvedValue(undefined),
    };
    const run = jest.fn().mockRejectedValue(new Error('job failed'));

    await expect(
      runWithJobLease(redis as never, 'circle', 50_000, run),
    ).rejects.toThrow('job failed');

    expect(run).toHaveBeenCalledWith('owner-token');
    expect(redis.releaseLease).toHaveBeenCalledWith(
      'job-lease:circle',
      'owner-token',
    );
  });

  it('marks unavailable coordination explicitly and does not run a contested lease', async () => {
    const redis = {
      tryAcquireLease: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(null),
      releaseLease: jest.fn(),
    };
    const run = jest.fn().mockResolvedValue(undefined);

    await expect(
      runWithJobLease(redis as never, 'circle', 50_000, run),
    ).resolves.toBe(true);
    expect(run).toHaveBeenCalledWith(undefined);
    await expect(
      runWithJobLease(redis as never, 'circle', 50_000, run),
    ).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(redis.releaseLease).not.toHaveBeenCalled();
  });
});
