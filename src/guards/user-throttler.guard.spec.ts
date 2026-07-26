import { UserThrottlerGuard } from './user-throttler.guard';

class ExposedUserThrottlerGuard extends UserThrottlerGuard {
  tracker(req: Record<string, unknown>) {
    return this.getTracker(req);
  }
}

describe('UserThrottlerGuard', () => {
  const guard = Object.create(
    ExposedUserThrottlerGuard.prototype,
  ) as ExposedUserThrottlerGuard;

  it('gives two JWT users on the same IP independent quotas (tracks by user id)', async () => {
    // 同一 NAT/代理 IP 上的两个不同用户 → 不同的计数键 → 各自独立额度。
    await expect(
      guard.tracker({ user: { userId: 'user-1' }, ip: 'shared-nat-ip' }),
    ).resolves.toBe('user:user-1');
    await expect(
      guard.tracker({ user: { userId: 'user-2' }, ip: 'shared-nat-ip' }),
    ).resolves.toBe('user:user-2');
  });

  it('falls back to the stock IP tracker without an authenticated user', async () => {
    await expect(guard.tracker({ ip: 'client-ip' })).resolves.toBe('client-ip');
  });
});
