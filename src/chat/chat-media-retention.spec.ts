import {
  CHAT_MEDIA_RETENTION_DAYS,
  expiredMediaContent,
  isChatMediaExpired,
} from './chat-media-retention';

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-11-10T12:00:00.000Z');
const sentDaysAgo = (days: number, extraMs = 0) =>
  new Date(now - days * DAY - extraMs).toISOString();

describe('chat media retention', () => {
  it('keeps videos 30 days and images, voice and files a year', () => {
    expect(CHAT_MEDIA_RETENTION_DAYS).toEqual({
      video: 30,
      image: 365,
      voice: 365,
      file: 365,
    });
  });

  it.each([
    ['video', 30],
    ['image', 365],
    ['voice', 365],
    ['file', 365],
  ])('%s expires exactly %i days after it was sent', (type, days) => {
    expect(
      isChatMediaExpired({ type, createdAt: sentDaysAgo(days, -1) }, now),
    ).toBe(false);
    expect(
      isChatMediaExpired({ type, createdAt: sentDaysAgo(days) }, now),
    ).toBe(true);
  });

  it('never expires non-media messages', () => {
    for (const type of ['text', 'quote', 'note-card', 'system'])
      expect(
        isChatMediaExpired({ type, createdAt: sentDaysAgo(3650) }, now),
      ).toBe(false);
  });

  // 阅后即焚有自己的销毁流程(含 180 天管理员归档),保留期不插手。
  it('leaves self-destructing messages to the burn lifecycle', () => {
    const old = sentDaysAgo(400);
    expect(
      isChatMediaExpired(
        { type: 'image', createdAt: old, burnDurationSec: 60 },
        now,
      ),
    ).toBe(false);
    expect(
      isChatMediaExpired(
        { type: 'video', createdAt: old, burnExpiresAt: old },
        now,
      ),
    ).toBe(false);
  });

  it('accepts Date and ISO string timestamps alike', () => {
    expect(
      isChatMediaExpired(
        { type: 'video', createdAt: new Date(now - 31 * DAY) },
        now,
      ),
    ).toBe(true);
  });

  it('drops object keys and urls but keeps the layout metadata', () => {
    expect(
      expiredMediaContent({
        key: 'chat/u1/a.mp4',
        thumbKey: 'chat/u1/a.jpg',
        coverKey: 'chat/u1/c.jpg',
        url: 'https://signed/a.mp4',
        thumbUrl: 'https://signed/a.jpg',
        width: 720,
        height: 1280,
        duration: 12,
        size: 2_000_000,
      }),
    ).toEqual({
      width: 720,
      height: 1280,
      duration: 12,
      size: 2_000_000,
      expired: true,
    });
  });
});
