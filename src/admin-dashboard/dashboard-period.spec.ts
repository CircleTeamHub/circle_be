import { DashboardRange } from './dashboard.dto';
import { buildDailySeries, resolveDashboardPeriod } from './dashboard-period';

describe('dashboard period', () => {
  it('uses the Asia/Shanghai calendar boundary for today', () => {
    const now = new Date('2026-07-29T01:23:45.000Z');

    const period = resolveDashboardPeriod(DashboardRange.Today, now);

    expect(period).toEqual({
      startAt: new Date('2026-07-28T16:00:00.000Z'),
      endAt: now,
      dayCount: 1,
    });
  });

  it.each([
    [DashboardRange.SevenDays, 7, '2026-07-22T16:00:00.000Z'],
    [DashboardRange.ThirtyDays, 30, '2026-06-29T16:00:00.000Z'],
  ])('resolves %s into a complete calendar range', (range, days, startAt) => {
    const period = resolveDashboardPeriod(
      range,
      new Date('2026-07-29T01:23:45.000Z'),
    );

    expect(period.dayCount).toBe(days);
    expect(period.startAt.toISOString()).toBe(startAt);
  });

  it('fills missing trend dates with zero', () => {
    const period = resolveDashboardPeriod(
      DashboardRange.SevenDays,
      new Date('2026-07-29T01:23:45.000Z'),
    );

    const series = buildDailySeries(period, [
      { date: '2026-07-24', count: BigInt(3) },
      { date: '2026-07-29', count: 8 },
    ]);

    expect(series).toHaveLength(7);
    expect(series[0]).toEqual({ date: '2026-07-23', value: 0 });
    expect(series[1]).toEqual({ date: '2026-07-24', value: 3 });
    expect(series[6]).toEqual({ date: '2026-07-29', value: 8 });
  });
});
