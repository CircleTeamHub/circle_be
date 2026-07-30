import { DashboardRange } from './dashboard.dto';
import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
  const users = { getMetrics: jest.fn() };
  const community = { getMetrics: jest.fn() };
  const commerce = { getMetrics: jest.fn() };
  const moderation = { getMetrics: jest.fn() };
  const system = { getMetrics: jest.fn() };
  const redis = {
    getJson: jest.fn(),
    setJson: jest.fn(),
  };
  const now = new Date('2026-07-29T12:00:00.000Z');
  let service: DashboardService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new DashboardService(
      users as never,
      community as never,
      commerce as never,
      moderation as never,
      system as never,
      redis as never,
    );
  });

  it('returns a cached dashboard without running section queries', async () => {
    const cached = {
      range: DashboardRange.SevenDays,
      generatedAt: now.toISOString(),
      startAt: '2026-07-23T00:00:00.000Z',
      endAt: now.toISOString(),
      sections: {},
    };
    redis.getJson.mockResolvedValue(cached);

    await expect(
      service.getDashboard(DashboardRange.SevenDays, now),
    ).resolves.toEqual(cached);
    expect(users.getMetrics).not.toHaveBeenCalled();
  });

  it('isolates a failed section and does not cache a partial dashboard', async () => {
    redis.getJson.mockResolvedValue(null);
    users.getMetrics.mockResolvedValue({ totalUsers: 10 });
    community.getMetrics.mockRejectedValue(new Error('database timeout'));
    commerce.getMetrics.mockResolvedValue({ pointSpend: 100 });
    moderation.getMetrics.mockResolvedValue({ pendingTotal: 2 });
    system.getMetrics.mockResolvedValue({ failed: 0 });

    const result = await service.getDashboard(DashboardRange.Today, now);

    expect(result.sections.users).toEqual({
      status: 'ok',
      data: { totalUsers: 10 },
    });
    expect(result.sections.community).toEqual({
      status: 'error',
      data: null,
    });
    expect(redis.setJson).not.toHaveBeenCalled();
  });

  it('caches a complete dashboard for 45 seconds', async () => {
    redis.getJson.mockResolvedValue(null);
    users.getMetrics.mockResolvedValue({ totalUsers: 10 });
    community.getMetrics.mockResolvedValue({ totalCircles: 3 });
    commerce.getMetrics.mockResolvedValue({ pointSpend: 100 });
    moderation.getMetrics.mockResolvedValue({ pendingTotal: 2 });
    system.getMetrics.mockResolvedValue({ failed: 0 });
    redis.setJson.mockResolvedValue(true);

    const result = await service.getDashboard(DashboardRange.ThirtyDays, now);

    expect(result.range).toBe(DashboardRange.ThirtyDays);
    expect(redis.setJson).toHaveBeenCalledWith(
      'admin:dashboard:30d',
      result,
      45,
    );
  });

  it('falls back to live metrics when the Redis cache read fails', async () => {
    redis.getJson.mockRejectedValue(new Error('redis unavailable'));
    users.getMetrics.mockResolvedValue({ totalUsers: 10 });
    community.getMetrics.mockResolvedValue({ totalCircles: 3 });
    commerce.getMetrics.mockResolvedValue({ pointSpend: 100 });
    moderation.getMetrics.mockResolvedValue({ pendingTotal: 2 });
    system.getMetrics.mockResolvedValue({ failed: 0 });
    redis.setJson.mockResolvedValue(true);

    await expect(
      service.getDashboard(DashboardRange.Today, now),
    ).resolves.toMatchObject({
      sections: {
        users: { status: 'ok', data: { totalUsers: 10 } },
      },
    });
    expect(users.getMetrics).toHaveBeenCalled();
  });

  it('returns complete live metrics when the Redis cache write fails', async () => {
    redis.getJson.mockResolvedValue(null);
    users.getMetrics.mockResolvedValue({ totalUsers: 10 });
    community.getMetrics.mockResolvedValue({ totalCircles: 3 });
    commerce.getMetrics.mockResolvedValue({ pointSpend: 100 });
    moderation.getMetrics.mockResolvedValue({ pendingTotal: 2 });
    system.getMetrics.mockResolvedValue({ failed: 0 });
    redis.setJson.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.getDashboard(DashboardRange.Today, now),
    ).resolves.toMatchObject({
      sections: {
        users: { status: 'ok', data: { totalUsers: 10 } },
      },
    });
  });
});
