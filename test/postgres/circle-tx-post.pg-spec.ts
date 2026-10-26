import type { Client } from 'pg';
import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import { NotificationService } from 'src/notification/notification.service';
import {
  backendPid,
  type CircleTxDb,
  createCircle,
  createUsers,
  openCircleTxDb,
  transactionsOf,
  waitUntilBlockedBy,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

/**
 * 发帖(CirclePlazaService.createPost)持有 Circle 行锁的时长。
 *
 * postCount 自增会给 Circle 行加行锁,而入圈(reserveCircleSeats)、改设置、别人
 * 发帖都要写这一行。原来自增排在建帖之后、写最多 500 条通知 + 500 条推送 outbox
 * 之前,整段扇出期间这一行都被占着;现在自增挪到事务最后一条写,行锁只覆盖提交。
 */
describePostgres('circle plaza createPost hot row (PostgreSQL)', () => {
  let t: CircleTxDb;
  let service: CirclePlazaService;
  let observer: Client;
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
    observer = await t.rawClient();
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
    await observer?.end();
    await t?.close();
  });

  it('bumps postCount as the last write of the transaction, after the notification fan-out', async () => {
    const before = await postCounts();
    t.setRecording(true);
    const post = await service.createPost(author, {
      content: 'hello',
      circleIds: [circleA, circleB],
    } as never);
    t.setRecording(false);

    // 结果不变:两个圈子各 +1,60 个去重后的收件人各一条通知 + 一条 outbox。
    expect(post.id).toEqual(expect.any(String));
    const after = await postCounts();
    expect(after[circleA]).toBe(before[circleA] + 1);
    expect(after[circleB]).toBe(before[circleB] + 1);
    expect(
      await t.prisma.notification.count({
        where: { fromCirclePostID: post.id, type: 'CIRCLE_POST_PUBLISHED' },
      }),
    ).toBe(60);
    expect(
      await t.prisma.notificationPushOutbox.count({
        where: { notification: { fromCirclePostID: post.id } },
      }),
    ).toBe(60);

    // 形状:事务里最后一条写是 Circle 的 postCount 自增,通知与 outbox 都在它之前。
    const [tx] = transactionsOf(t.statements).filter((statements) =>
      statements.some((sql) => /INSERT INTO "[^"]+"\."CirclePost"/.test(sql)),
    );
    const writes = tx
      .filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))
      .map((sql) => sql.slice(0, 120));
    expect(writes[writes.length - 1]).toMatch(
      /UPDATE "[^"]+"\."Circle" SET "postCount"/,
    );
    const circleUpdate = tx.findIndex((sql) =>
      /UPDATE "[^"]+"\."Circle" SET "postCount"/.test(sql),
    );
    const lastFanout = Math.max(
      ...tx
        .map((sql, index) =>
          /INSERT INTO "[^"]+"\."(Notification|NotificationPushOutbox)"/.test(
            sql,
          )
            ? index
            : -1,
        )
        .filter((index) => index >= 0),
    );
    expect(lastFanout).toBeGreaterThan(0);
    expect(circleUpdate).toBeGreaterThan(lastFanout);
  });

  it('leaves the Circle row writable while the fan-out is still being written', async () => {
    // 把发帖事务卡在推送 outbox 的插入上(此时帖子与通知已写)。
    const gate = await t.rawClient();
    const seatWriter = await t.rawClient();
    try {
      await gate.query('BEGIN');
      await gate.query('LOCK TABLE "NotificationPushOutbox" IN SHARE MODE');
      const pending = service.createPost(author, {
        content: 'gated',
        circleIds: [circleA],
      } as never);
      await waitUntilBlockedBy(observer, await backendPid(gate));

      // 入圈占座要写同一行 Circle。发帖事务此刻还在扇出,不能占着这一行。
      await seatWriter.query(`SET lock_timeout = '500ms'`);
      const seat = await seatWriter.query(
        `UPDATE "Circle" SET "memberCount" = "memberCount" + 1 WHERE id = $1`,
        [circleA],
      );
      expect(seat.rowCount).toBe(1);

      await gate.query('COMMIT');
      await expect(pending).resolves.toMatchObject({ id: expect.any(String) });
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      await gate.end();
      await seatWriter.end();
    }
  });
});
