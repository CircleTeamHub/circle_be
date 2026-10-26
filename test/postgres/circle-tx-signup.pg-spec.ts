import { NotFoundException } from '@nestjs/common';
import type { Client } from 'pg';
import { CirclePlazaService } from 'src/circle-plaza/circle-plaza.service';
import { MembershipPolicyService } from 'src/membership/membership-policy.service';
import { MembershipProgramService } from 'src/membership/membership-program.service';
import {
  type CircleTxDb,
  createCircle,
  createUsers,
  openCircleTxDb,
  backendPid,
  transactionsOf,
  waitUntilBlockedBy,
} from './circle-tx-harness';
import { describePostgres } from './pg-test-db';

/**
 * 广场报名(CirclePlazaService.signupForPost)的真库回归。
 *
 * 原来报名在 Serializable 事务里自增 CirclePost.signupCount:热门帖上并发报名的
 * 事务快照都早于彼此的提交,写同一行就是 40001,重试三次仍可能 500。报名没有人数
 * 上限,Serializable 防的不是超卖;改成读已提交 + 一条带帖子状态条件的原子自增,
 * 行锁让并发报名排队而不是互相回滚,帖子在报名途中被删/结束时条件更新落空、整笔回滚。
 */
describePostgres('circle plaza signup transactions (PostgreSQL)', () => {
  let t: CircleTxDb;
  let service: CirclePlazaService;
  let observer: Client;
  let author: string;
  let fans: string[];
  let circleId: string;

  const createPost = async () =>
    (
      await t.prisma.circlePost.create({
        data: {
          content: 'hot',
          authorID: author,
          circleID: circleId,
          expiresAt: new Date(Date.now() + 3_600_000),
          circleLinks: { create: [{ circleID: circleId }] },
        },
        select: { id: true },
      })
    ).id;

  const signupRows = async (postId: string) =>
    t.prisma.circlePostSignup.count({ where: { postID: postId } });
  const signupCount = async (postId: string) =>
    (
      await t.prisma.circlePost.findUniqueOrThrow({
        where: { id: postId },
        select: { signupCount: true },
      })
    ).signupCount;

  beforeAll(async () => {
    t = await openCircleTxDb('circle_tx_signup', { poolMax: 20 });
    observer = await t.rawClient();
    [author, ...fans] = await createUsers(t.prisma, 17);
    circleId = await createCircle(t.prisma, author, fans);
    const membership = new MembershipPolicyService(
      t.prisma as never,
      new MembershipProgramService(t.prisma as never),
    );
    service = new CirclePlazaService(
      t.prisma as never,
      { get: () => undefined } as never,
      {
        broadcastSignupUnread: async () => undefined,
        broadcastInteractionUnread: async () => undefined,
        broadcastNotificationCreated: () => undefined,
      } as never,
      { createCirclePostSignupNotification: async () => null } as never,
      {} as never,
      membership,
      {} as never,
    );
  }, 60_000);

  afterAll(async () => {
    await observer?.end();
    await t?.close();
  });

  it('lets 16 concurrent signups on one post all succeed without a single retry', async () => {
    const postId = await createPost();
    t.setRecording(true);
    const results = await Promise.all(
      fans.map((fan) => service.signupForPost(fan, postId)),
    );
    t.setRecording(false);

    expect(results.every((r) => r.signed)).toBe(true);
    // 每次返回的是自己那次自增后的值:16 个人拿到 1..16 各一次。
    expect(results.map((r) => r.signupCount).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1),
    );
    expect(await signupRows(postId)).toBe(16);
    expect(await signupCount(postId)).toBe(16);

    // 形状:每个人恰好一个事务,没有一个回滚重来;事务是读已提交,不再 Serializable。
    const signups = transactionsOf(t.statements).filter((tx) =>
      tx.some((sql) => sql.includes('INSERT INTO') && sql.includes('Signup')),
    );
    expect(signups).toHaveLength(16);
    expect(signups.every((tx) => /^COMMIT/i.test(tx[tx.length - 1]))).toBe(
      true,
    );
    expect(
      signups.some((tx) => tx.some((sql) => /SERIALIZABLE/i.test(sql))),
    ).toBe(false);
  });

  it('reads post visibility once per signup instead of before and again inside the transaction', async () => {
    const postId = await createPost();
    t.setRecording(true);
    await service.signupForPost(fans[0], postId);
    t.setRecording(false);

    // 可见性 = 帖子 ACTIVE 未过期(读 CirclePost)+ 本人是某个关联圈子的 ACTIVE
    // 成员(读 CircleMember)。原来事务外、事务内各一遍,现在各一次。
    const selects = t.statements.filter(({ sql }) =>
      /^SELECT/i.test(sql.trim()),
    );
    const postReads = selects.filter(({ sql }) =>
      /FROM "[^"]+"\."CirclePost" /.test(sql),
    );
    const membershipReads = selects.filter(({ sql }) =>
      sql.includes('"CircleMember"'),
    );
    expect(postReads).toHaveLength(1);
    expect(membershipReads).toHaveLength(1);
    // 计数只靠一条带状态条件的 UPDATE ... RETURNING。
    const counterWrites = t.statements.filter(
      ({ sql }) =>
        /^UPDATE/i.test(sql.trim()) &&
        sql.includes('"CirclePost"') &&
        sql.includes('"signupCount"'),
    );
    expect(counterWrites).toHaveLength(1);
    expect(counterWrites[0].sql).toMatch(/"status"/);
    expect(counterWrites[0].sql).toMatch(/RETURNING/i);
  });

  it('keeps double taps idempotent: one row, count 1, every tap reports signed', async () => {
    const postId = await createPost();
    const taps = await Promise.all(
      Array.from({ length: 4 }, () => service.signupForPost(fans[1], postId)),
    );

    expect(taps.every((r) => r.signed && r.signupCount === 1)).toBe(true);
    expect(await signupRows(postId)).toBe(1);
    expect(await signupCount(postId)).toBe(1);
  });

  it('rolls the signup back when the post is deleted while the signup waits on it', async () => {
    const postId = await createPost();
    const deleter = await t.rawClient();
    try {
      await deleter.query('BEGIN');
      await deleter.query(
        `UPDATE "CirclePost" SET status = 'DELETED' WHERE id = $1`,
        [postId],
      );
      const pending = service.signupForPost(fans[2], postId).then(
        () => 'signed',
        (error: unknown) => error,
      );
      // 报名事务必须真的卡在帖子行上,断言才有意义。
      await waitUntilBlockedBy(observer, await backendPid(deleter));
      await deleter.query('COMMIT');

      const outcome = await pending;
      expect(outcome).toBeInstanceOf(NotFoundException);
      expect(await signupRows(postId)).toBe(0);
      expect(await signupCount(postId)).toBe(0);
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      await deleter.end();
    }
  });
});
