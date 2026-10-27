import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 20261025000200 ~ 0400(会话行热点的三个迁移)在真 PostgreSQL 上的效果:3000 人的群里
 * 「新消息让隐藏会话浮出」的 UPDATE 走部分索引,而不是逐座位回表;会话行上只剩
 * name 的 trigram 索引。
 *
 * RESURFACE_SQL 是 Prisma 7 为
 *   chatMember.updateMany({ where: { conversationID, hiddenAt: { not: null } }, data: { hiddenAt: null } })
 * 编译出的语句形状(去掉 schema 前缀,离线编译核对过)。源码里的过滤条件由
 * src/chat/chat-hot-row-indexes-migration.spec.ts 钉住。
 */
const RESURFACE_SQL = `UPDATE "ChatMember" SET "hiddenAt" = $1
  WHERE ("ChatMember"."conversationID" = $2 AND "ChatMember"."hiddenAt" IS NOT NULL)`;

const MIGRATIONS = [
  '20261025000200_chat_hot_row_indexes',
  '20261025000300_drop_conversation_id_trgm',
  '20261025000400_drop_conversation_circle_trgm',
];

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('chat hot-row indexes (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const indexNames = async (table: string) => {
    const { rows } = await s.db.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = $2',
      [s.schema, table],
    );
    return rows.map((row) => row.indexname).sort();
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('chat_hot_row');
    await s.db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await s.db.query(`
      CREATE TABLE "ChatConversation" (id text PRIMARY KEY, name text, "circleID" text);
      CREATE INDEX "ChatConversation_id_trgm_idx" ON "ChatConversation" USING gin (id gin_trgm_ops);
      CREATE INDEX "ChatConversation_name_trgm_idx" ON "ChatConversation" USING gin (name gin_trgm_ops);
      CREATE INDEX "ChatConversation_circleID_trgm_idx" ON "ChatConversation" USING gin ("circleID" gin_trgm_ops);
      CREATE TABLE "ChatMember" (
        "conversationID" text NOT NULL, "userID" text NOT NULL,
        "leftAt" timestamp, "clearedBeforeHeight" integer NOT NULL DEFAULT 0,
        muted boolean NOT NULL DEFAULT false, "hiddenAt" timestamp
      );
      CREATE UNIQUE INDEX "ChatMember_conversationID_userID_key" ON "ChatMember"("conversationID", "userID");
      CREATE INDEX "ChatMember_fanout_idx" ON "ChatMember"("conversationID", "leftAt", "clearedBeforeHeight", "userID", muted);
      INSERT INTO "ChatMember" ("conversationID", "userID", "hiddenAt")
      SELECT 'c' || (g % 20), 'u' || g, CASE WHEN g % 997 = 0 THEN now() END
      FROM generate_series(1, 60000) g;
    `);
    // CONCURRENTLY 不能放进多语句的隐式事务:逐条执行,和 Prisma 部署时一样。
    for (const name of MIGRATIONS) {
      const migration = readFileSync(
        join(process.cwd(), 'prisma/migrations', name, 'migration.sql'),
        'utf8',
      );
      for (const statement of statements(migration)) {
        await s.db.query(statement);
      }
    }
    await s.db.query('ANALYZE "ChatMember"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('lets the planner pick the partial index for the resurface update on its own', async () => {
    const plan = await explainPlan(s.db, RESURFACE_SQL, [null, 'c1']);

    expect(plan).toContain('ChatMember_hidden_conversation_idx');
    expect(plan).not.toContain('Seq Scan');
  });

  it('still resurfaces exactly the hidden seats of that conversation', async () => {
    await s.db.query('BEGIN');
    try {
      const target = await s.db.query(
        `SELECT count(*)::int AS n FROM "ChatMember" WHERE "conversationID" = 'c1' AND "hiddenAt" IS NOT NULL`,
      );
      const result = await s.db.query(RESURFACE_SQL, [null, 'c1']);
      const elsewhere = await s.db.query(
        `SELECT count(*)::int AS n FROM "ChatMember" WHERE "hiddenAt" IS NOT NULL`,
      );

      expect(result.rowCount).toBe(target.rows[0].n);
      expect(result.rowCount).toBeGreaterThan(0);
      expect(elsewhere.rows[0].n).toBeGreaterThan(0);
      const left = await s.db.query(
        `SELECT count(*)::int AS n FROM "ChatMember" WHERE "conversationID" = 'c1' AND "hiddenAt" IS NOT NULL`,
      );
      expect(left.rows[0].n).toBe(0);
    } finally {
      await s.db.query('ROLLBACK');
    }
  });

  it('drops the UUID trigram indexes and keeps the name one', async () => {
    expect(await indexNames('ChatConversation')).toEqual([
      'ChatConversation_name_trgm_idx',
      'ChatConversation_pkey',
    ]);
  });
});
