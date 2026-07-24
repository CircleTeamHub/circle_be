const DURATION_UNITS_IN_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
  y: 365.25 * 24 * 60 * 60 * 1000,
  year: 365.25 * 24 * 60 * 60 * 1000,
  years: 365.25 * 24 * 60 * 60 * 1000,
};

export function parseDurationMilliseconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^([0-9]+(?:\.[0-9]+)?)\s*([a-z]+)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const multiplier = DURATION_UNITS_IN_MS[unit];
  if (!Number.isFinite(amount) || amount <= 0 || !multiplier) return null;
  const milliseconds = amount * multiplier;
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? milliseconds
    : null;
}
