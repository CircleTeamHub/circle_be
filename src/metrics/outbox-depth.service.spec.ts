import { createJobMetrics } from './job-metrics';
import {
  collectOutboxDepths,
  OUTBOX_PROBE_MAX_CONCURRENT_QUERIES,
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
    circleInvitationVerifier: delegate(
      overrides.circleInvitationVerifier ?? empty,
    ),
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

  it('covers the verification-card queue introduced by the server-issued cards work', async () => {
    // #147 新增的 sweepUndeliveredVerificationCards 是又一条「静默丢失」路径：
    // 席位提交后卡片就地签发，失败则留空由补偿任务逐轮补投，打光 36 次后
    // 永久放弃。schema 注释写明它与 CoinGift 同构。
    const samples = await collectOutboxDepths(
      fakePrisma({
        circleInvitationVerifier: {
          count: 4,
          oldest: TEN_MINUTES_AGO,
          dead: 2,
        },
      }),
      NOW,
    );

    const card = samples.find((s) => s.queue === 'verification_card');
    expect(card).toEqual({
      queue: 'verification_card',
      pending: 4,
      oldestAgeSeconds: 600,
      dead: 2,
    });
  });

  it('never holds more than one database call open at a time', async () => {
    // review #150：并发版本在每个整分钟同时开 8 个连接（5 个队列 × pending/dead
    // 两查），而池默认只有 10、其余 EVERY_MINUTE 处理器又都在同一个边界点火。
    // 一次慢查询就足以让这个纯观测任务把池吃干净，把真实请求排到 10 秒获取
    // 超时上。
    let inFlight = 0;
    let peak = 0;
    const track = async <T>(value: T): Promise<T> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // 让出一个 microtask，模拟真实查询的等待窗口：并发实现会在这里把所有
      // 调用一起挂起，peak 随之冲高。
      await Promise.resolve();
      await Promise.resolve();
      inFlight -= 1;
      return value;
    };
    const delegate = () => ({
      aggregate: jest.fn(() =>
        track({ _count: { _all: 0 }, _min: { createdAt: null } }),
      ),
      count: jest.fn(() => track(0)),
    });
    const prisma = {
      sessionRevocationOutbox: delegate(),
      notificationPushOutbox: delegate(),
      friendChatReplayOutbox: delegate(),
      coinGift: delegate(),
      circleInvitationVerifier: delegate(),
    } as unknown as OutboxDepthSource;

    const samples = await collectOutboxDepths(prisma, NOW);

    expect(samples).toHaveLength(OUTBOX_QUEUES.length);
    expect(peak).toBeLessThanOrEqual(OUTBOX_PROBE_MAX_CONCURRENT_QUERIES);
  });

  it('keeps probing the remaining queues after a slow one fails', async () => {
    // 串行化不能把「单队列失败只丢它自己」丢掉：那是这段代码最初的设计约束。
    // 失败的队列排在中间时，后面的队列必须照常读到数。
    const prisma = fakePrisma();
    prisma.notificationPushOutbox.aggregate = jest
      .fn()
      .mockRejectedValue(new Error('lock timeout'));

    const samples = await collectOutboxDepths(prisma, NOW);

    expect(samples.map((sample) => sample.queue).sort()).toEqual(
      OUTBOX_QUEUES.filter((queue) => queue.name !== 'notification_push')
        .map((queue) => queue.name)
        .sort(),
    );
  });

  it('scopes the verification-card queue exactly like its sweeper does', async () => {
    // 待处理条件与 sweepUndeliveredVerificationCards 必须一致 —— 少了「父邀请
    // 仍 PENDING」这条，指标会把补偿任务根本不会碰的行算成积压，积压告警
    // 于是常年 firing。
    const prisma = fakePrisma();
    await collectOutboxDepths(prisma, NOW);

    const where = (prisma.circleInvitationVerifier.aggregate as jest.Mock).mock
      .calls[0][0].where;
    expect(where).toMatchObject({
      status: 'PENDING',
      invitation: { is: { status: 'PENDING' } },
      cardDeliveredAt: null,
    });
    expect(where.cardAttempts).toEqual({ lt: 36 });
  });
});
