import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 会话列表的群人数与成员目录的圈子角色,两条都是 Prisma 生成的查询。SQL 形状来自离线
 * 编译(假 driver adapter 记录 Prisma 7 发出的语句,去掉 "public". 前缀):
 *
 * GROUP_COUNT_SQL —— chat.service.ts loadGroupMemberCounts 的
 *   chatMember.groupBy({ by: ['conversationID'],
 *     where: { conversationID: { in: ids }, leftAt: null }, _count: { _all: true } })
 * rolesSql(n) —— chat.service.ts listMembers 的
 *   circleMember.findMany({ where: { circleID, status: 'ACTIVE', userID: { in: userIds } },
 *     select: { userID: true, role: true } })
 *   (IN 列表按 userID 个数展开成 $3..$n+2)
 */
const GROUP_COUNT_SQL = `SELECT COUNT(*) AS "_count$_all", "ChatMember"."conversationID" FROM "ChatMember"
  WHERE ("ChatMember"."conversationID" IN ($1,$2) AND "ChatMember"."leftAt" IS NULL)
  GROUP BY "ChatMember"."conversationID" OFFSET $3`;

const rolesSql = (userCount: number) => {
  const ids = Array.from({ length: userCount }, (_, i) => `$${i + 3}`).join(
    ',',
  );
  return `SELECT "CircleMember"."id", "CircleMember"."userID", "CircleMember"."role"::text FROM "CircleMember"
    WHERE ("CircleMember"."circleID" = $1
      AND "CircleMember"."status" = CAST($2::text AS "CircleMemberStatus")
      AND "CircleMember"."userID" IN (${ids})) OFFSET $${userCount + 3}`;
};

describePostgres('chat member counts and directory roles (PostgreSQL)', () => {
  let s: IsolatedSchema;

  beforeAll(async () => {
    s = await openIsolatedSchema('chat_member_directory');
    await s.db.query(`
      CREATE TYPE "CircleMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
      CREATE TYPE "CircleMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
      CREATE TABLE "CircleMember" (
        id text PRIMARY KEY, "userID" text NOT NULL, "circleID" text NOT NULL,
        role "CircleMemberRole" NOT NULL DEFAULT 'MEMBER',
        status "CircleMemberStatus" NOT NULL DEFAULT 'PENDING'
      );
      CREATE UNIQUE INDEX "CircleMember_userID_circleID_key" ON "CircleMember"("userID", "circleID");
      CREATE INDEX "CircleMember_circleID_idx" ON "CircleMember"("circleID");
      CREATE INDEX "CircleMember_circleID_status_userID_idx" ON "CircleMember"("circleID", status, "userID");
      CREATE TABLE "ChatMember" (
        id text PRIMARY KEY, "conversationID" text NOT NULL, "userID" text NOT NULL,
        "leftAt" timestamp(3), "clearedBeforeHeight" integer NOT NULL DEFAULT 0,
        muted boolean NOT NULL DEFAULT false
      );
      CREATE UNIQUE INDEX "ChatMember_conversationID_userID_key" ON "ChatMember"("conversationID", "userID");
      CREATE INDEX "ChatMember_userID_idx" ON "ChatMember"("userID");
      CREATE INDEX "ChatMember_fanout_idx" ON "ChatMember"("conversationID", "leftAt", "clearedBeforeHeight", "userID", muted);
      -- g1:3000 个座位,其中 1/10 已退群;g2:50 人;另有 300 个群各 100 人当背景。
      INSERT INTO "ChatMember" (id, "conversationID", "userID", "leftAt")
      SELECT 'g1-' || g, 'g1', 'u' || g, CASE WHEN g % 10 = 0 THEN now() END FROM generate_series(1, 3000) g;
      INSERT INTO "ChatMember" (id, "conversationID", "userID")
      SELECT 'g2-' || g, 'g2', 'u' || g FROM generate_series(1, 50) g;
      INSERT INTO "ChatMember" (id, "conversationID", "userID")
      SELECT 'bg-' || c || '-' || g, 'bg-' || c, 'b' || g FROM generate_series(1, 300) c, generate_series(1, 100) g;
      -- 圈子 big:4000 个 ACTIVE 成员(比群里在座的多)、500 个 PENDING;另有 200 个圈子背景。
      INSERT INTO "CircleMember" (id, "userID", "circleID", role, status)
      SELECT 'cm-' || g, 'u' || g, 'big',
             (CASE WHEN g = 1 THEN 'OWNER' WHEN g <= 5 THEN 'ADMIN' ELSE 'MEMBER' END)::"CircleMemberRole",
             (CASE WHEN g <= 4000 THEN 'ACTIVE' ELSE 'PENDING' END)::"CircleMemberStatus"
      FROM generate_series(1, 4500) g;
      INSERT INTO "CircleMember" (id, "userID", "circleID", status)
      SELECT 'o-' || c || '-' || g, 'o' || g, 'other-' || c, 'ACTIVE' FROM generate_series(1, 200) c, generate_series(1, 100) g;
    `);
    // 线上这两张表有 autovacuum 维护可见性映射,index-only scan 才划算;刚灌完数据的
    // 测试表要先 VACUUM 一遍,规划器看到的才是稳态。
    await s.db.query('VACUUM ANALYZE "ChatMember"');
    await s.db.query('VACUUM ANALYZE "CircleMember"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('counts only seats that have not left', async () => {
    const { rows } = await s.db.query<{
      conversationID: string;
      _count$_all: string;
    }>(GROUP_COUNT_SQL, ['g1', 'g2', 0]);

    expect(
      Object.fromEntries(
        rows.map((row) => [row.conversationID, Number(row._count$_all)]),
      ),
    ).toEqual({ g1: 2700, g2: 50 });
  });

  it('counts group seats with an index-only read of ChatMember_fanout_idx', async () => {
    const plan = await explainPlan(s.db, GROUP_COUNT_SQL, ['g1', 'g2', 0]);

    type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
    const nodes = (node: PlanNode): PlanNode[] => [
      node,
      ...(node.Plans ?? []).flatMap(nodes),
    ];
    const scan = nodes(
      (JSON.parse(plan) as Array<{ Plan: PlanNode }>)[0].Plan,
    ).find((node) => node['Index Name'] === 'ChatMember_fanout_idx');

    expect(scan?.['Node Type']).toBe('Index Only Scan');
    // leftAt IS NULL 是索引条件(fanout 索引的第二列),不是回表过滤。
    expect(scan?.['Index Cond']).toContain('"leftAt" IS NULL');
    expect(scan?.Filter).toBeUndefined();
    expect(plan).not.toContain('Seq Scan');
  });

  it('reads roles only for the seated users, through the circle index', async () => {
    const seated = Array.from({ length: 2700 }, (_, i) => `u${i + 1}`);
    const values = ['big', 'ACTIVE', ...seated, 0];
    const { rows } = await s.db.query<{ userID: string; role: string }>(
      rolesSql(seated.length),
      values,
    );
    const plan = await explainPlan(s.db, rolesSql(seated.length), values);

    expect(rows).toHaveLength(2700);
    expect(rows.filter((row) => row.role !== 'MEMBER')).toHaveLength(5);
    expect(plan).toMatch(
      /CircleMember_(circleID_status_userID_idx|userID_circleID_key|circleID_idx)/,
    );
    expect(plan).not.toContain('Seq Scan');
  });
});
