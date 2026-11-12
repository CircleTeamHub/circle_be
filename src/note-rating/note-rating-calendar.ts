// Asia/Shanghai is UTC+8 all year (no daylight saving), so a fixed offset is exact.
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RatingCalendar = {
  /** Shanghai calendar date as a UTC-midnight Date — what a `@db.Date` column holds. */
  day: Date;
  /** `YYYY-MM-DD` of `day`, for raw SQL `::date` parameters. */
  dayKey: string;
  /** `YYYY-MM` of `day`: the displayed-counter bucket. */
  month: string;
  /** Instants at which this Shanghai day / month started and the next day starts. */
  dayStart: Date;
  nextDayStart: Date;
  monthStart: Date;
};

export function ratingCalendar(now: Date): RatingCalendar {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const day = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  );
  const dayStart = new Date(day.getTime() - SHANGHAI_OFFSET_MS);
  return {
    day,
    dayKey: dayKeyOf(day),
    month: monthOf(day),
    dayStart,
    nextDayStart: new Date(dayStart.getTime() + DAY_MS),
    monthStart: new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) -
        SHANGHAI_OFFSET_MS,
    ),
  };
}

/** `ratedDay` values come back from Postgres as UTC-midnight Dates. */
export function dayKeyOf(day: Date): string {
  return day.toISOString().slice(0, 10);
}

export function monthOf(day: Date): string {
  return day.toISOString().slice(0, 7);
}
