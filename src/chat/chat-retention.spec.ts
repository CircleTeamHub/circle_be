import {
  buildChatRetentionWindow,
  chatRetentionWhere,
  effectiveBurnDurationForMessage,
  isChatMessageVisible,
} from './chat-retention';

describe('chat retention window', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');
  const startedAt = new Date('2026-09-14T10:00:00.000Z');

  it('does not add a burn restriction when burn is disabled', () => {
    const window = buildChatRetentionWindow(
      { burnDurationSec: null, burnStartedAt: null },
      null,
      now,
    );

    expect(
      isChatMessageVisible(new Date('2020-01-01T00:00:00.000Z'), window),
    ).toBe(true);
    expect(chatRetentionWhere(window)).toEqual({});
  });

  it('keeps duration-only behavior for a legacy enabled row without a start', () => {
    const window = buildChatRetentionWindow(
      { burnDurationSec: 3600, burnStartedAt: null },
      null,
      now,
    );

    expect(
      isChatMessageVisible(new Date('2026-09-14T10:30:00.000Z'), window),
    ).toBe(false);
    expect(
      isChatMessageVisible(new Date('2026-09-14T11:30:00.000Z'), window),
    ).toBe(true);
  });

  it('preserves messages from before burn was enabled', () => {
    const window = buildChatRetentionWindow(
      { burnDurationSec: 3600, burnStartedAt: startedAt },
      null,
      now,
    );

    expect(
      isChatMessageVisible(new Date('2026-09-14T09:59:59.000Z'), window),
    ).toBe(true);
    expect(chatRetentionWhere(window)).toEqual({
      AND: [
        {
          OR: [
            { createdAt: { lt: startedAt } },
            { createdAt: { gte: new Date('2026-09-14T11:00:00.000Z') } },
          ],
        },
      ],
    });
  });

  it('hides expired post-start messages and still applies viewer retention', () => {
    const viewerCutoff = new Date('2026-09-14T08:00:00.000Z');
    const window = buildChatRetentionWindow(
      { burnDurationSec: 3600, burnStartedAt: startedAt },
      viewerCutoff,
      now,
    );

    expect(
      isChatMessageVisible(new Date('2026-09-14T10:30:00.000Z'), window),
    ).toBe(false);
    expect(
      isChatMessageVisible(new Date('2026-09-14T11:30:00.000Z'), window),
    ).toBe(true);
    expect(
      isChatMessageVisible(new Date('2026-09-14T07:59:59.000Z'), window),
    ).toBe(false);
  });

  it('marks only post-start messages as ephemeral in response DTOs', () => {
    const policy = { burnDurationSec: 3600, burnStartedAt: startedAt };

    expect(
      effectiveBurnDurationForMessage(
        policy,
        new Date('2026-09-14T09:00:00.000Z'),
      ),
    ).toBeNull();
    expect(
      effectiveBurnDurationForMessage(
        policy,
        new Date('2026-09-14T10:00:00.000Z'),
      ),
    ).toBe(3600);
  });
});
