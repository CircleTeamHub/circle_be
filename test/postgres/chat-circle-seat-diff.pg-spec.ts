import {
  type CircleSeatChange,
  circleSeatDiffQuery,
} from 'src/chat/chat-circle-seat-diff.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 圈子成员 ←→ 群座位对账的差集在真 PostgreSQL 上的口径与成本:座位增(新建/复活)、
 * 删(成员不再 ACTIVE)、无变化三种情况;3000 人的圈子查差集只走两张表的索引,
 * 不把成员和座位整份读回应用,也不拼 ≤3000 个参数的 IN / NOT IN。
 */
describePostgres('circle seat diff (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const diff = async (circleId: string, conversationId: string) => {
    const q = circleSeatDiffQuery(circleId, conversationId);
    const { rows } = await s.db.query<CircleSeatChange>(q.text, q.values);
    return rows;
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('circle_seat_diff');
    await s.db.query(`
      CREATE TYPE "CircleMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
      CREATE TABLE "CircleMember" (
        id text PRIMARY KEY, "userID" text NOT NULL, "circleID" text NOT NULL,
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
    `);
  });

  afterAll(async () => {
    await s?.close();
  });

  beforeEach(async () => {
    await s.db.query('TRUNCATE "CircleMember", "ChatMember"');
  });

  /** big:3000 个 ACTIVE 成员、座位全对齐;另有 200 个别的圈子各 50 人当背景数据。 */
  const seedAlignedCircle = async () => {
    await s.db.query(`
      INSERT INTO "CircleMember" (id, "userID", "circleID", status)
      SELECT 'big-' || g, 'u' || g, 'big', 'ACTIVE' FROM generate_series(1, 3000) g;
      INSERT INTO "ChatMember" (id, "conversationID", "userID")
      SELECT 'seat-big-' || g, 'conv-big', 'u' || g FROM generate_series(1, 3000) g;
      INSERT INTO "CircleMember" (id, "userID", "circleID", status)
      SELECT 'o-' || g, 'o' || g, 'other-' || (g % 200), 'ACTIVE' FROM generate_series(1, 10000) g;
      INSERT INTO "ChatMember" (id, "conversationID", "userID")
      SELECT 'seat-o-' || g, 'conv-other-' || (g % 200), 'o' || g FROM generate_series(1, 10000) g;
    `);
    await s.db.query('ANALYZE "CircleMember"');
    await s.db.query('ANALYZE "ChatMember"');
  };

  it('returns nothing when every ACTIVE member already holds a live seat', async () => {
    await seedAlignedCircle();

    expect(await diff('big', 'conv-big')).toEqual([]);
  });

  it('reports added members: no seat yet → create, left seat → rejoin', async () => {
    await seedAlignedCircle();
    await s.db.query(`
      INSERT INTO "CircleMember" (id, "userID", "circleID", status) VALUES
        ('n1', 'newcomer', 'big', 'ACTIVE'),
        ('n2', 'returning', 'big', 'ACTIVE'),
        ('n3', 'applicant', 'big', 'PENDING');
      INSERT INTO "ChatMember" (id, "conversationID", "userID", "leftAt") VALUES
        ('s-returning', 'conv-big', 'returning', now());
      -- newcomer 在别的会话里有座位,不算。
      INSERT INTO "ChatMember" (id, "conversationID", "userID") VALUES
        ('s-elsewhere', 'conv-other-1', 'newcomer');
    `);

    expect(await diff('big', 'conv-big')).toEqual([
      { userID: 'newcomer', action: 'create' },
      { userID: 'returning', action: 'rejoin' },
    ]);
  });

  it('reports removed members: live seats whose owner is no longer ACTIVE', async () => {
    await seedAlignedCircle();
    await s.db.query(`
      UPDATE "CircleMember" SET status = 'PENDING' WHERE id = 'big-7';
      DELETE FROM "CircleMember" WHERE id = 'big-8';
      -- 已经离座的不再报。
      DELETE FROM "CircleMember" WHERE id = 'big-9';
      UPDATE "ChatMember" SET "leftAt" = now() WHERE id = 'seat-big-9';
      -- 在别的圈子 ACTIVE 不算数。
      INSERT INTO "CircleMember" (id, "userID", "circleID", status) VALUES ('x', 'u8', 'other-1', 'ACTIVE');
    `);

    expect(await diff('big', 'conv-big')).toEqual([
      { userID: 'u7', action: 'remove' },
      { userID: 'u8', action: 'remove' },
    ]);
  });

  it('reads both tables through their indexes, never a sequential scan', async () => {
    await seedAlignedCircle();
    const q = circleSeatDiffQuery('big', 'conv-big');
    const plan = await explainPlan(s.db, q.text, q.values);

    // 两侧都按 circleID / conversationID 前缀取这一个圈子、这一个会话的行(具体挑
    // 哪条同前缀的索引、位图还是 index-only,随统计信息变),其它圈子的行不碰。
    expect(plan).toMatch(/CircleMember_circleID_(status_userID_)?idx/);
    expect(plan).toMatch(/ChatMember_(conversationID_userID_key|fanout_idx)/);
    expect(plan).not.toContain('Seq Scan');
  });
});
