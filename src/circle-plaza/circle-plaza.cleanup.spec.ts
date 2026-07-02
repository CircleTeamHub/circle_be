import { CirclePlazaCleanup } from './circle-plaza.cleanup';

describe('CirclePlazaCleanup', () => {
  const service = { sweepExpiredPosts: jest.fn() };
  const job = new CirclePlazaCleanup(service as any);

  beforeEach(() => jest.clearAllMocks());

  it('drains full batches until the sweep returns an empty batch', async () => {
    service.sweepExpiredPosts
      .mockResolvedValueOnce({ count: 100 })
      .mockResolvedValueOnce({ count: 100 })
      .mockResolvedValueOnce({ count: 0 });

    await job.sweepExpiredPosts();

    // two full batches drained, then the empty batch stops the loop
    expect(service.sweepExpiredPosts).toHaveBeenCalledTimes(3);
  });

  it('stops after a single empty batch', async () => {
    service.sweepExpiredPosts.mockResolvedValue({ count: 0 });

    await job.sweepExpiredPosts();

    expect(service.sweepExpiredPosts).toHaveBeenCalledTimes(1);
  });

  it('caps the number of batches drained in one tick', async () => {
    service.sweepExpiredPosts.mockResolvedValue({ count: 100 });

    await job.sweepExpiredPosts();

    // MAX_SWEEP_BATCHES_PER_TICK = 50
    expect(service.sweepExpiredPosts).toHaveBeenCalledTimes(50);
  });

  it('does not run a second sweep while one is already running', async () => {
    let resolveFirst: (value: { count: number }) => void = () => {};
    service.sweepExpiredPosts.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );

    const firstTick = job.sweepExpiredPosts();
    // second tick fires while the first is still in flight → guarded out
    await job.sweepExpiredPosts();
    expect(service.sweepExpiredPosts).toHaveBeenCalledTimes(1);

    resolveFirst({ count: 0 });
    await firstTick;
  });

  it('does not throw when the sweep fails and releases the running guard', async () => {
    service.sweepExpiredPosts.mockRejectedValueOnce(new Error('boom'));

    await expect(job.sweepExpiredPosts()).resolves.toBeUndefined();

    // guard released: a later tick can run again
    service.sweepExpiredPosts.mockResolvedValueOnce({ count: 0 });
    await job.sweepExpiredPosts();
    expect(service.sweepExpiredPosts).toHaveBeenCalledTimes(2);
  });
});
