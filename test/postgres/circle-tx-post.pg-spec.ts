import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import { NotificationService } from 'src/notification/notification.service';
import {
  type CircleTxDb,
  createCircle,
  createUsers,
  openCircleTxDb,
  transactionsOf,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

/**
 * 发帖(CirclePlazaService.createPost)的事务形状。
 *
 * postCount 自增会给 Circle 行加行锁,而入圈(reserveCircleSeats)、改设置、别人
 * 发帖都要写这一行,所以自增必须是事务最后一条写,行锁只覆盖提交。发帖不写通知,
 * 事务里也不该再出现 Notification / 推送 outbox 的写入。
 */
describePostgres('circle plaza createPost hot row (PostgreSQL)', () => {
  let t: CircleTxDb;
  let service: CirclePlazaService;
  let author: string;
  let members: string[];
  let circleA: string;
  let circleB: string;

  const postCounts = async () =>
    Object.fromEntries(
      (
        await t.prisma.circle.findMany({
          where: { id: { in: [circleA, circleB] } },
          select: { id: true, postCount: true },
        })
      ).map((row) => [row.id, row.postCount]),
    );

  beforeAll(async () => {
    t = await openCircleTxDb('circle_tx_post');
    [author, ...members] = await createUsers(t.prisma, 61);
    circleA = await createCircle(t.prisma, author, members.slice(0, 40));
    circleB = await createCircle(t.prisma, author, members.slice(30));
    const membership = new MembershipPolicyService(
      t.prisma as never,
      new MembershipProgramService(t.prisma as never),
    );
    const realtime = {
      broadcastNotificationCreated: () => undefined,
      broadcastInteractionUnread: async () => undefined,
      claimCirclePlazaPokes: async () => [],
    };
    service = new CirclePlazaService(
      t.prisma as never,
      { get: () => undefined } as never,
      realtime as never,
      new NotificationService(t.prisma as never, realtime as never),
      { getDisplayIconsForUsers: async () => new Map() } as never,
      membership,
      { resolvePublicAppearances: async () => new Map() } as never,
    );
  }, 60_000);

  afterAll(async () => {
    await t?.close();
  });

  it('publishes with no notification rows and bumps postCount as the last write', async () => {
    const before = await postCounts();
    t.setRecording(true);
    const post = await service.createPost(author, {
      content: 'hello',
      circleIds: [circleA, circleB],
    } as never);
    t.setRecording(false);

    expect(post.id).toEqual(expect.any(String));
    const after = await postCounts();
    expect(after[circleA]).toBe(before[circleA] + 1);
    expect(after[circleB]).toBe(before[circleB] + 1);
    expect(
      await t.prisma.notification.count({
        where: { fromCirclePostID: post.id },
      }),
    ).toBe(0);

    const [tx] = transactionsOf(t.statements).filter((statements) =>
      statements.some((sql) => /INSERT INTO "[^"]+"\."CirclePost"/.test(sql)),
    );
    const writes = tx
      .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))
      .map((sql) => sql.slice(0, 120));
    expect(writes[writes.length - 1]).toMatch(
      /UPDATE "[^"]+"\."Circle" SET "postCount"/,
    );
    expect(writes.join('\n')).not.toMatch(
      /INSERT INTO "[^"]+"\."(Notification|NotificationPushOutbox)"/,
    );
  });
});
