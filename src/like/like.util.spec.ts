import { likedOnToday } from './like.util';

describe('likedOnToday', () => {
  it('truncates the timestamp to UTC midnight', () => {
    const d = likedOnToday(new Date('2026-06-28T15:30:45.123Z'));
    expect(d.toISOString()).toBe('2026-06-28T00:00:00.000Z');
  });

  it('maps any time on the same UTC day to the same bucket', () => {
    const start = likedOnToday(new Date('2026-06-28T00:00:00.000Z'));
    const end = likedOnToday(new Date('2026-06-28T23:59:59.999Z'));
    expect(start.getTime()).toBe(end.getTime());
  });
});
