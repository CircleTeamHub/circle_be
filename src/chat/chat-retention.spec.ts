import {
  buildChatRetentionWindow,
  chatRetentionWhere,
  effectiveBurnDurationForMessage,
  isChatMessageVisible,
} from './chat-retention';

describe('chat retention window', () => {
  const now = new Date('2026-09-14T12:00:00.000Z');
  const startedAt = new Date('2026-09-14T10:00:00.000Z');
  const noViewer = { cutoff: null, startedAt: null };

  it('does not add a burn restriction when burn is disabled', () => {
    const window = buildChatRetentionWindow(
      { burnDurationSec: null, burnStartedAt: null },
      noViewer,
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
      noViewer,
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
      noViewer,
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
      { cutoff: viewerCutoff, startedAt: null },
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

  // ——— 全局阅后即焚(UserPrivacySetting.messageSelfDestructSec)的开启边界 ———
  // 会话级焚毁早就有 burnStartedAt 保护开启前的消息;查看者侧的这个窗口一直
  // 缺同样的下界,打开开关等于把此前的全部历史一次性隐藏。

  it('preserves messages from before global self-destruct was enabled', () => {
    const viewerStartedAt = new Date('2026-09-14T09:00:00.000Z');
    const viewerCutoff = new Date('2026-09-14T11:00:00.000Z');
    const window = buildChatRetentionWindow(
      { burnDurationSec: null, burnStartedAt: null },
      { cutoff: viewerCutoff, startedAt: viewerStartedAt },
      now,
    );

    // 开启之前发出的:远早于窗口下沿,但不该被这个开关隐藏。
    expect(
      isChatMessageVisible(new Date('2026-09-14T08:59:59.000Z'), window),
    ).toBe(true);
    // 开启之后发出、但已经超出窗口的:隐藏。
    expect(
      isChatMessageVisible(new Date('2026-09-14T09:30:00.000Z'), window),
    ).toBe(false);
    // 开启之后发出、仍在窗口内的:可见。
    expect(
      isChatMessageVisible(new Date('2026-09-14T11:30:00.000Z'), window),
    ).toBe(true);
  });

  it('keeps cutoff-only behavior for a viewer without a start', () => {
    const viewerCutoff = new Date('2026-09-14T11:00:00.000Z');
    const window = buildChatRetentionWindow(
      { burnDurationSec: null, burnStartedAt: null },
      { cutoff: viewerCutoff, startedAt: null },
      now,
    );

    expect(
      isChatMessageVisible(new Date('2026-09-14T10:59:59.000Z'), window),
    ).toBe(false);
    expect(
      isChatMessageVisible(new Date('2026-09-14T11:30:00.000Z'), window),
    ).toBe(true);
  });

  it('emits a viewer start clause symmetric to the burn one', () => {
    const viewerStartedAt = new Date('2026-09-14T09:00:00.000Z');
    const viewerCutoff = new Date('2026-09-14T11:00:00.000Z');
    const window = buildChatRetentionWindow(
      { burnDurationSec: null, burnStartedAt: null },
      { cutoff: viewerCutoff, startedAt: viewerStartedAt },
      now,
    );

    expect(chatRetentionWhere(window)).toEqual({
      AND: [
        {
          OR: [
            { createdAt: { lt: viewerStartedAt } },
            { createdAt: { gte: viewerCutoff } },
          ],
        },
      ],
    });
  });

  it('applies both boundaries independently when burn is also on', () => {
    const viewerStartedAt = new Date('2026-09-14T09:00:00.000Z');
    const viewerCutoff = new Date('2026-09-14T09:30:00.000Z');
    const window = buildChatRetentionWindow(
      { burnDurationSec: 3600, burnStartedAt: startedAt },
      { cutoff: viewerCutoff, startedAt: viewerStartedAt },
      now,
    );

    // 两个开关启用前发出的:两侧都放行。
    expect(
      isChatMessageVisible(new Date('2026-09-14T08:00:00.000Z'), window),
    ).toBe(true);
    // 会话焚毁启用前、但落在查看者窗口外:仍被查看者侧隐藏。
    expect(
      isChatMessageVisible(new Date('2026-09-14T09:15:00.000Z'), window),
    ).toBe(false);
    // 两侧都启用之后、超出焚毁窗口:隐藏。
    expect(
      isChatMessageVisible(new Date('2026-09-14T10:30:00.000Z'), window),
    ).toBe(false);
    // 两侧都启用之后、仍在窗口内:可见。
    expect(
      isChatMessageVisible(new Date('2026-09-14T11:30:00.000Z'), window),
    ).toBe(true);
  });
});
