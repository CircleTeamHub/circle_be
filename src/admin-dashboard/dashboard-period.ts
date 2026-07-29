import { DashboardRange } from './dashboard.dto';

const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DashboardPeriod = {
  startAt: Date;
  endAt: Date;
  dayCount: number;
};

export function resolveDashboardPeriod(
  range: DashboardRange,
  now = new Date(),
): DashboardPeriod {
  let dayCount = 1;
  if (range === DashboardRange.SevenDays) dayCount = 7;
  if (range === DashboardRange.ThirtyDays) dayCount = 30;
  const chinaNow = new Date(now.getTime() + CHINA_OFFSET_MS);
  const todayStartUtc =
    Date.UTC(
      chinaNow.getUTCFullYear(),
      chinaNow.getUTCMonth(),
      chinaNow.getUTCDate(),
    ) - CHINA_OFFSET_MS;
  return {
    startAt: new Date(todayStartUtc - (dayCount - 1) * DAY_MS),
    endAt: now,
    dayCount,
  };
}

export function buildDailySeries(
  period: DashboardPeriod,
  rows: Array<{ date?: string; day?: Date; count: bigint | number }>,
): Array<{ date: string; value: number }> {
  const values = new Map(
    rows.map((row) => [
      row.date ?? chinaDateKey(row.day ?? period.startAt),
      Number(row.count),
    ]),
  );
  return Array.from({ length: period.dayCount }, (_, index) => {
    const date = new Date(period.startAt.getTime() + index * DAY_MS);
    const key = chinaDateKey(date);
    return { date: key, value: values.get(key) ?? 0 };
  });
}

function chinaDateKey(date: Date): string {
  return new Date(date.getTime() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}
