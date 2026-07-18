import { ImTokenThrottlerGuard } from './im-token-throttler.guard';

class ExposedImTokenThrottlerGuard extends ImTokenThrottlerGuard {
  tracker(req: Record<string, unknown>) {
    return this.getTracker(req);
  }
}

describe('ImTokenThrottlerGuard', () => {
  const guard = Object.create(
    ExposedImTokenThrottlerGuard.prototype,
  ) as ExposedImTokenThrottlerGuard;

  it('tracks an authenticated request by JWT user id', async () => {
    await expect(
      guard.tracker({ user: { userId: 'user-1' }, ip: '10.0.0.1' }),
    ).resolves.toBe('user:user-1');
  });

  it('falls back to the stock IP tracker without an authenticated user', async () => {
    await expect(guard.tracker({ ip: '10.0.0.1' })).resolves.toBe('10.0.0.1');
  });
});
