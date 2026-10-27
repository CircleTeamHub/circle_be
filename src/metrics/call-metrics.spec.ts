import { CallEndReason } from 'src/generated/prisma';
import {
  CALL_ANSWERED_DURATION_BUCKETS_SECONDS,
  CALL_ENDING_REASONS,
  callMetrics,
  createCallMetrics,
  recordCallAccept,
  recordCallEnding,
  recordCallSetup,
  recordLiveKitWebhook,
} from './call-metrics';

const KINDS = ['direct', 'group'];
const ended = new Date('2026-10-26T03:00:00.000Z');
const secondsBefore = (seconds: number) =>
  new Date(ended.getTime() - seconds * 1000);

describe('createCallMetrics', () => {
  it('exports every setup/accept/webhook combination at zero before the first call', async () => {
    // 从 0 开始导出：increase() 才能把进程启动后的第一批失败算进失败率。
    const output = await createCallMetrics().registry.metrics();

    for (const kind of KINDS) {
      for (const result of [
        'started',
        'busy',
        'livekit_unavailable',
        'failed',
      ]) {
        expect(output).toMatch(
          new RegExp(
            `circle_call_setups_total\\{kind="${kind}",result="${result}"\\} 0`,
          ),
        );
      }
      for (const result of ['accepted', 'too_late', 'failed']) {
        expect(output).toMatch(
          new RegExp(
            `circle_call_accepts_total\\{kind="${kind}",result="${result}"\\} 0`,
          ),
        );
      }
    }
    for (const result of ['handled', 'ignored', 'rejected', 'failed']) {
      expect(output).toMatch(
        new RegExp(
          `circle_call_livekit_webhooks_total\\{result="${result}"\\} 0`,
        ),
      );
    }
  });

  it('exports every kind/reason/answered ending combination at zero', async () => {
    const output = await createCallMetrics().registry.metrics();
    const reasons = [
      'normal',
      'canceled',
      'all_left',
      'no_answer',
      'timeout',
      'network',
      'error',
    ];
    expect([...CALL_ENDING_REASONS]).toEqual(reasons);

    for (const kind of KINDS) {
      for (const reason of reasons) {
        for (const answered of ['true', 'false']) {
          expect(output).toMatch(
            new RegExp(
              `circle_call_endings_total\\{kind="${kind}",reason="${reason}",answered="${answered}"\\} 0`,
            ),
          );
        }
      }
    }
  });

  it('maps every CallEndReason onto a pre-seeded lower-case reason label', async () => {
    const metrics = createCallMetrics();
    for (const reason of Object.values(CallEndReason)) {
      metrics.recordEnding({
        kind: 'group',
        reason,
        startedAt: null,
        endedAt: ended,
      });
    }

    const output = await metrics.registry.metrics();
    for (const reason of Object.values(CallEndReason)) {
      expect(output).toMatch(
        new RegExp(
          `circle_call_endings_total\\{kind="group",reason="${reason.toLowerCase()}",answered="false"\\} 1`,
        ),
      );
    }
    expect(output).not.toMatch(/reason="undefined"/);
  });

  it('uses exactly the alerting bucket boundaries and pre-seeds both kinds', async () => {
    expect([...CALL_ANSWERED_DURATION_BUCKETS_SECONDS]).toEqual([
      5, 10, 30, 60, 180, 600, 1800, 3600,
    ]);
    const output = await createCallMetrics().registry.metrics();

    for (const kind of KINDS) {
      for (const le of ['5', '10', '30', '60', '180', '600', '1800', '3600']) {
        expect(output).toMatch(
          new RegExp(
            `circle_call_answered_duration_seconds_bucket\\{le="${le}",kind="${kind}"\\} 0`,
          ),
        );
      }
      expect(output).toMatch(
        new RegExp(
          `circle_call_answered_duration_seconds_bucket\\{le="\\+Inf",kind="${kind}"\\} 0`,
        ),
      );
      expect(output).toMatch(
        new RegExp(
          `circle_call_answered_duration_seconds_count\\{kind="${kind}"\\} 0`,
        ),
      );
    }
    expect(output).not.toMatch(/le="2\.5"/);
  });

  it('counts setups and accepts per kind and result', async () => {
    const metrics = createCallMetrics();

    metrics.recordSetup('direct', 'busy');
    metrics.recordSetup('direct', 'busy');
    metrics.recordSetup('group', 'livekit_unavailable');
    metrics.recordAccept('group', 'too_late');

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_call_setups_total\{kind="direct",result="busy"\} 2/,
    );
    expect(output).toMatch(
      /circle_call_setups_total\{kind="group",result="livekit_unavailable"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_accepts_total\{kind="group",result="too_late"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_accepts_total\{kind="direct",result="too_late"\} 0/,
    );
  });

  it('marks answered endings and observes their duration at the bucket boundary', async () => {
    const metrics = createCallMetrics();

    // 恰好 10 秒：le="10" 是上界含等号，必须落在 10 这一桶里。
    metrics.recordEnding({
      kind: 'direct',
      reason: CallEndReason.ALL_LEFT,
      startedAt: secondsBefore(10),
      endedAt: ended,
    });
    metrics.recordEnding({
      kind: 'direct',
      reason: CallEndReason.NORMAL,
      startedAt: secondsBefore(125),
      endedAt: ended,
    });

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_call_endings_total\{kind="direct",reason="all_left",answered="true"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_endings_total\{kind="direct",reason="normal",answered="true"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_bucket\{le="5",kind="direct"\} 0/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_bucket\{le="10",kind="direct"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_bucket\{le="60",kind="direct"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_bucket\{le="180",kind="direct"\} 2/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_sum\{kind="direct"\} 135/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_count\{kind="direct"\} 2/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_count\{kind="group"\} 0/,
    );
  });

  it('does not observe a duration for calls that were never answered', async () => {
    const metrics = createCallMetrics();

    metrics.recordEnding({
      kind: 'group',
      reason: CallEndReason.NO_ANSWER,
      startedAt: null,
      endedAt: ended,
    });
    metrics.recordEnding({
      kind: 'group',
      reason: CallEndReason.CANCELED,
      startedAt: undefined,
      endedAt: ended,
    });

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_call_endings_total\{kind="group",reason="no_answer",answered="false"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_endings_total\{kind="group",reason="canceled",answered="false"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_count\{kind="group"\} 0/,
    );
  });

  it('clamps a negative duration (clock skew) to zero', async () => {
    const metrics = createCallMetrics();

    metrics.recordEnding({
      kind: 'group',
      reason: CallEndReason.ALL_LEFT,
      startedAt: new Date(ended.getTime() + 3_000),
      endedAt: ended,
    });

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_bucket\{le="5",kind="group"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_answered_duration_seconds_sum\{kind="group"\} 0/,
    );
  });

  it('counts webhook results', async () => {
    const metrics = createCallMetrics();

    metrics.recordLiveKitWebhook('rejected');
    metrics.recordLiveKitWebhook('rejected');
    metrics.recordLiveKitWebhook('handled');

    const output = await metrics.registry.metrics();
    expect(output).toMatch(
      /circle_call_livekit_webhooks_total\{result="rejected"\} 2/,
    );
    expect(output).toMatch(
      /circle_call_livekit_webhooks_total\{result="handled"\} 1/,
    );
    expect(output).toMatch(
      /circle_call_livekit_webhooks_total\{result="failed"\} 0/,
    );
  });
});

describe('call metric recorders', () => {
  afterEach(() => jest.restoreAllMocks());

  it('swallow recorder failures so metrics never change the call outcome', () => {
    const boom = () => {
      throw new Error('registry broken');
    };
    jest.spyOn(callMetrics, 'recordSetup').mockImplementation(boom);
    jest.spyOn(callMetrics, 'recordAccept').mockImplementation(boom);
    jest.spyOn(callMetrics, 'recordEnding').mockImplementation(boom);
    jest.spyOn(callMetrics, 'recordLiveKitWebhook').mockImplementation(boom);

    expect(() => recordCallSetup('direct', 'started')).not.toThrow();
    expect(() => recordCallAccept('group', 'accepted')).not.toThrow();
    expect(() =>
      recordCallEnding({
        kind: 'direct',
        reason: CallEndReason.NORMAL,
        startedAt: null,
        endedAt: ended,
      }),
    ).not.toThrow();
    expect(() => recordLiveKitWebhook('failed')).not.toThrow();
  });

  it('forward to the shared singleton registry', async () => {
    recordCallSetup('group', 'failed');

    expect(await callMetrics.registry.metrics()).toMatch(
      /circle_call_setups_total\{kind="group",result="failed"\} [1-9]/,
    );
  });
});
