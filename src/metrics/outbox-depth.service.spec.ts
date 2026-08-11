import { createJobMetrics } from './job-metrics';
import {
  collectOutboxDepths,
  OUTBOX_QUEUES,
  type OutboxDepthSource,
} from './outbox-depth.service';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const TEN_MINUTES_AGO = new Date(NOW.getTime() - 10 * 60_000);

/** 每个 delegate 都返回同一组读数，除非在 overrides 里指定。 */
function fakePrisma(
  overrides: Partial<
    Record<
      keyof OutboxDepthSource,
      { count: number; oldest: Date | null; dead?: number }
    >
  > = {},
): OutboxDepthSource {
  const delegate = (reading: {
    count: number;
    oldest: Date | null;
    dead?: number;
  }) => ({
    aggregate: jest.fn().mockResolvedValue({
      _count: { _all: reading.count },
      _min: { createdAt: reading.oldest },
    }),
    count: jest.fn().mockResolvedValue(reading.dead ?? 0),
  });

  const empty = { count: 0, oldest: null as Date | null, dead: 0 };
  return {
    sessionRevocationOutbox: delegate(
      overrides.sessionRevocationOutbox ?? empty,
    ),
    notificationPushOutbox: delegate(overrides.notificationPushOutbox ?? empty),
    friendChatReplayOutbox: delegate(overrides.friendChatReplayOutbox ?? empty),
    coinGift: delegate(overrides.coinGift ?? empty),
  };
}

describe('collectOutboxDepths', () => {
  it('reports every known queue on every pass', async () => {
    const samples = await collectOutboxDepths(fakePrisma(), NOW);

    expect(samples.map((sample) => sample.queue).sort()).toEqual(
      OUTBOX_QUEUES.map((queue) => queue.name).sort(),
    );
  });

  it('derives oldest age in seconds from the oldest pending row', async () => {
    const samples = await collectOutboxDepths(
      fakePrisma({
        notificationPushOutbox: {
          count: 12,
          oldest: TEN_MINUTES_AGO,
          dead: 4,
        },
      }),
      NOW,
    );

    const push = samples.find((s) => s.queue === 'notification_push');
    expect(push).toEqual({
      queue: 'notification_push',
      pending: 12,
      oldestAgeSeconds: 600,
      dead: 4,
    });
  });

  it('reports an empty queue as zeros instead of omitting it', async () => {
    // 队列排空后必须继续上报 0 —— 序列消失会让 `> 阈值` 告警静默失效。
    const samples = await collectOutboxDepths(fakePrisma(), NOW);

    for (const sample of samples) {
      expect(sample.pending).toBe(0);
      expect(sample.oldestAgeSeconds).toBe(0);
      expect(sample.dead).toBe(0);
    }
  });

  it('never reports a negative age when a row is timestamped in the future', async () => {
    // 多实例时钟漂移 / createdAt 用了 DB 时钟而 now 用进程时钟。
    const samples = await collectOutboxDepths(
      fakePrisma({
        coinGift: { count: 1, oldest: new Date(NOW.getTime() + 30_000) },
      }),
      NOW,
    );

    const gift = samples.find((s) => s.queue === 'gift_card');
    expect(gift?.oldestAgeSeconds).toBe(0);
  });

  it('counts a stuck row that is still PENDING as backlog, not as dead', async () => {
    const samples = await collectOutboxDepths(
      fakePrisma({
        friendChatReplayOutbox: { count: 3, oldest: TEN_MINUTES_AGO, dead: 0 },
      }),
      NOW,
    );

    const replay = samples.find((s) => s.queue === 'friend_chat_replay');
    expect(replay?.pending).toBe(3);
    expect(replay?.dead).toBe(0);
  });

  it('lets one failing queue not blank out the others', async () => {
    // 单表查询失败（迁移中、锁等待）不能让整轮探测丢掉所有读数 —— 那会让
    // 所有队列的序列一起消失，积压告警集体静默。
    const prisma = fakePrisma({
      notificationPushOutbox: { count: 5, oldest: TEN_MINUTES_AGO },
    });
    prisma.sessionRevocationOutbox.aggregate = jest
      .fn()
      .mockRejectedValue(new Error('relation does not exist'));

    const samples = await collectOutboxDepths(prisma, NOW);

    expect(samples.find((s) => s.queue === 'notification_push')?.pending).toBe(
      5,
    );
    expect(
      samples.find((s) => s.queue === 'session_revocation'),
    ).toBeUndefined();
  });

  it('feeds the gauges through setOutboxDepth', async () => {
    const metrics = createJobMetrics();
    const samples = await collectOutboxDepths(
      fakePrisma({
        sessionRevocationOutbox: { count: 9, oldest: TEN_MINUTES_AGO },
      }),
      NOW,
    );
    for (const sample of samples) metrics.setOutboxDepth(sample);

    const text = await metrics.registry.metrics();
    expect(text).toMatch(
      /circle_outbox_pending\{queue="session_revocation"\}\s+9/,
    );
    expect(text).toMatch(
      /circle_outbox_oldest_age_seconds\{queue="session_revocation"\}\s+600/,
    );
  });
});
