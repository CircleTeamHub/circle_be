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

    expect(run).toHaveBeenCalledWith(
      'owner-token',
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
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
    expect(run).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    await expect(
      runWithJobLease(redis as never, 'circle', 50_000, run),
    ).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    expect(redis.releaseLease).not.toHaveBeenCalled();
  });

  it('renews a long job, clears the renewal timer and releases on completion', async () => {
    jest.useFakeTimers();
    const redis = {
      tryAcquireLease: jest.fn().mockResolvedValue('owner'),
      renewLease: jest.fn().mockResolvedValue(true),
      releaseLease: jest.fn(),
    };
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let current!: () => boolean;
    const running = runWithJobLease(
      redis as never,
      'slow',
      90,
      async (_token, lease) => {
        current = lease.isCurrent;
        await held;
      },
    );
    try {
      await jest.advanceTimersByTimeAsync(250);
      expect(current()).toBe(true);
      expect(redis.renewLease).toHaveBeenCalledWith(
        'job-lease:slow',
        'owner',
        90,
      );
      expect(redis.renewLease.mock.calls.length).toBeGreaterThan(2);
      finish();
      await running;
      const renewals = redis.renewLease.mock.calls.length;
      await jest.advanceTimersByTimeAsync(100);
      expect(redis.renewLease).toHaveBeenCalledTimes(renewals);
      expect(redis.releaseLease).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await running;
      jest.useRealTimers();
    }
  });

  it.each([false, new Error('Redis unavailable')])(
    'marks the lease lost when renewal fails: %s',
    async (result) => {
      jest.useFakeTimers();
      const redis = {
        tryAcquireLease: jest.fn().mockResolvedValue('owner'),
        renewLease: jest.fn(),
        releaseLease: jest.fn(),
      };
      if (result instanceof Error) redis.renewLease.mockRejectedValue(result);
      else redis.renewLease.mockResolvedValue(result);
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let current!: () => boolean;
      const running = runWithJobLease(
        redis as never,
        'slow',
        90,
        async (_token, lease) => {
          current = lease.isCurrent;
          await held;
        },
      );
      try {
        await jest.advanceTimersByTimeAsync(40);
        expect(current()).toBe(false);
        await jest.advanceTimersByTimeAsync(100);
        expect(redis.renewLease).toHaveBeenCalledTimes(1);
      } finally {
        finish();
        await running;
        jest.useRealTimers();
      }
    },
  );
});
