import {
  buildChatRetentionWindow,
  chatRetentionWhere,
  NO_VIEWER_RETENTION,
} from './chat-retention';
import { messageDaysQuery, messageDayWindows } from './chat-message-days.query';

const iso = (date: Date) => date.toISOString();

describe('messageDayWindows', () => {
  it('splits a month into client-offset days (getTimezoneOffset semantics)', () => {
    // 东八区 getTimezoneOffset = -480:当地 8/1 00:00 = UTC 7/31 16:00。
    const windows = messageDayWindows(2026, 7, -480);

    expect(windows).toHaveLength(31);
    expect(windows[0]).toEqual({
      day: '2026-08-01',
      start: new Date('2026-07-31T16:00:00.000Z'),
      end: new Date('2026-08-01T16:00:00.000Z'),
    });
    expect(windows[30].day).toBe('2026-08-31');
    expect(iso(windows[30].end)).toBe('2026-08-31T16:00:00.000Z');
  });

  it('follows the IANA zone across a DST switch', () => {
    const windows = messageDayWindows(2026, 2, 420, 'America/Los_Angeles');
    const byDay = Object.fromEntries(
      windows.map((w) => [w.day, [iso(w.start), iso(w.end)]]),
    );

    expect(windows).toHaveLength(31);
    // 月界和原来一样:3/1 00:00 PST 到 4/1 00:00 PDT。
    expect(iso(windows[0].start)).toBe('2026-03-01T08:00:00.000Z');
    expect(iso(windows[30].end)).toBe('2026-04-01T07:00:00.000Z');
    // 3/8 凌晨切夏令时:这一天只有 23 小时。
    expect(byDay['2026-03-07']).toEqual([
      '2026-03-07T08:00:00.000Z',
      '2026-03-08T08:00:00.000Z',
    ]);
    expect(byDay['2026-03-08']).toEqual([
      '2026-03-08T08:00:00.000Z',
      '2026-03-09T07:00:00.000Z',
    ]);
  });

  // 原来是逐条消息用同一个 formatter 归日;现在是按天的 [start, end) 去库里问。
  // 两种做法必须对任何时刻给出同一个日期。
  it.each([
    'Asia/Shanghai',
    'America/Los_Angeles',
    'Asia/Kolkata',
    'Australia/Lord_Howe',
    'Pacific/Chatham',
    'Europe/London',
  ])(
    'labels every instant of the month exactly like per-row formatting (%s)',
    (timeZone) => {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const label = (date: Date) => {
        const parts = formatter.formatToParts(date);
        const part = (type: string) =>
          parts.find((p) => p.type === type)?.value;
        return `${part('year')}-${part('month')}-${part('day')}`;
      };
      for (const [year, month] of [
        [2026, 2],
        [2026, 3],
        [2026, 9],
      ]) {
        const windows = messageDayWindows(year, month, 0, timeZone);
        const first = windows[0].start.getTime();
        const last = windows[windows.length - 1].end.getTime();
        for (let t = first; t < last; t += 7 * 60_000 + 13_000) {
          const hit = windows.find(
            (w) => w.start.getTime() <= t && t < w.end.getTime(),
          );
          expect(hit?.day).toBe(label(new Date(t)));
        }
        // 窗口首尾相接,整月不重不漏。
        for (let i = 1; i < windows.length; i += 1) {
          expect(windows[i].start).toEqual(windows[i - 1].end);
        }
      }
    },
  );
});

describe('messageDaysQuery', () => {
  it('asks per day whether one visible message exists, on the live createdAt index shape', () => {
    const windows = messageDayWindows(2026, 7, -480);
    const query = messageDaysQuery('conv-1', 7, windows);
    const sql = query.sql.replace(/\s+/g, ' ');

    expect(sql).toContain('WHERE EXISTS');
    // 字面量:ChatMessage_live_conversation_createdAt_idx 是 WHERE deleted = false 的部分索引。
    expect(sql).toContain('m."deleted" = false');
    expect(sql).toContain('m."height" > ?');
    expect(sql).toContain(
      '(m."burnExpiresAt" IS NULL OR m."burnExpiresAt" > NOW())',
    );
    expect(query.values).toEqual([
      windows.map((w) => w.day),
      windows.map((w) => iso(w.start)),
      windows.map((w) => iso(w.end)),
      'conv-1',
      7,
    ]);
  });

  // messageDaysQuery 手写了 getHistory 那把尺子(chatRetentionWhere)的 SQL 版本。
  // 那边一改(比如重新启用查看者窗口),这里必须跟着改,否则日历和历史对不上。
  it('mirrors the current history retention filter', () => {
    const window = buildChatRetentionWindow(
      { burnDurationSec: 60, burnStartedAt: new Date() },
      NO_VIEWER_RETENTION,
    );

    expect(chatRetentionWhere(window)).toEqual({
      AND: [
        {
          OR: [
            { burnExpiresAt: null },
            { burnExpiresAt: { gt: expect.any(Date) } },
          ],
        },
      ],
    });
  });
});
