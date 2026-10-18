import {
  buildChatRetentionWindow,
  chatRetentionWhere,
  isChatMessageVisible,
  NO_VIEWER_RETENTION,
} from './chat-retention';

describe('sender-owned message retention', () => {
  const createdAt = new Date('2020-01-01');
  const window = buildChatRetentionWindow(
    { burnDurationSec: 60, burnStartedAt: new Date('2019-01-01') },
    { cutoff: new Date(), startedAt: new Date('2019-01-01') },
  );
  it('legacy shared and viewer settings cannot remove an unstamped message', () => {
    expect(window).toEqual({
      viewerCutoff: null,
      viewerStartedAt: null,
      burnCutoff: null,
      burnStartedAt: null,
    });
    expect(isChatMessageVisible(createdAt, window, null)).toBe(true);
  });
  it('expiry hides a sender message for every viewer, even with their settings off', () => {
    const off = buildChatRetentionWindow({}, NO_VIEWER_RETENTION);
    expect(isChatMessageVisible(createdAt, off, new Date(Date.now() - 1))).toBe(
      false,
    );
    expect(
      isChatMessageVisible(createdAt, off, new Date(Date.now() + 60_000)),
    ).toBe(true);
  });
  it('the exact deadline is expired', () => {
    jest.useFakeTimers().setSystemTime(1791936000000);
    try {
      expect(isChatMessageVisible(createdAt, window, new Date())).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
  it('history/search use the same expiry and allow normal peer messages', () => {
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
