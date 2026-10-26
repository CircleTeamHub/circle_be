import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChatBurnSweeperService } from 'src/chat/chat-burn-sweeper.service';
import { capturePrisma, captureQueries } from './prisma-sql-capture';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 焚毁清扫每分钟一次的「哪些会话有到期未扫的消息」在真 PostgreSQL 上的成本。
 *
 * 扫描语句现场生成:真跑一次 ChatBurnSweeperService.sweepOnce,交给只记录不执行的
 * Prisma 客户端(prisma-sql-capture),抓下它发出的 chatConversation.findMany,再来
 * 真库执行、EXPLAIN。源码里的过滤条件改了,这里跟着变。
 *
 * 原有的 ChatMessage_burn_expiry_active_idx 以 conversationID 打头:按到期时间找只能
 * 把整个部分索引(全部开着焚毁、还没到期的消息)扫一遍。20261026000310 补一条以
 * burnExpiresAt 打头的部分索引,到期的那一小段直接按范围取。
 */
/** sweepOnce 在给定共享游标下发出的「哪些会话有到期消息」扫描。 */
const sweepScan = async (cursor: string | null) => {
  const capture = capturePrisma();
  const redis = {
    getJsonMany: () => Promise.resolve([cursor]),
    setJsonIfVersionMatches: () => Promise.resolve(true),
  };
  const sweeper = new ChatBurnSweeperService(
    capture.prisma as never,
    {} as never,
    {} as never,
    redis as never,
  ) as unknown as {
    sweepOnce(token: undefined, lease: { isCurrent(): boolean }): Promise<void>;
  };
  const queries = await captureQueries(capture.queries, () =>
    sweeper.sweepOnce(undefined, { isCurrent: () => true }),
  );
  const scan = queries.find((query) =>
    query.sql.startsWith('SELECT "ChatConversation"'),
  );
  if (!scan) throw new Error('sweep scan query was not captured');
  return scan;
};

const MIGRATION = '20261026000310_chat_message_burn_due_index';

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('burn sweep conversation scan (PostgreSQL)', () => {
  let s: IsolatedSchema;

  beforeAll(async () => {
    s = await openIsolatedSchema('chat_burn_due');
    await s.db.query(`
      CREATE TABLE "ChatConversation" (id text PRIMARY KEY);
      CREATE TABLE "ChatMessage" (
        id text PRIMARY KEY, "conversationID" text NOT NULL, height integer NOT NULL,
        deleted boolean NOT NULL DEFAULT false, "burnExpiresAt" timestamp(3)
      );
      CREATE UNIQUE INDEX "ChatMessage_conversationID_height_key" ON "ChatMessage"("conversationID", height);
      CREATE INDEX "ChatMessage_burn_expiry_active_idx" ON "ChatMessage" ("conversationID", "burnExpiresAt")
        WHERE deleted = false AND "burnExpiresAt" IS NOT NULL;
      INSERT INTO "ChatConversation" SELECT 'c' || lpad(g::text, 6, '0') FROM generate_series(1, 20000) g;
      -- 每个会话 20 条:一半开着焚毁、还没到期,七分之一是墓碑。
      INSERT INTO "ChatMessage"
      SELECT 'm' || g, 'c' || lpad((g % 20000 + 1)::text, 6, '0'), g, g % 7 = 0,
             CASE WHEN g % 2 = 0 THEN now() + interval '1 day' END
      FROM generate_series(1, 400000) g;
      -- 到期还没扫的:三个会话;已经烧成墓碑的到期消息不算。
      INSERT INTO "ChatMessage" VALUES
        ('due-1', 'c000100', 1000001, false, now() - interval '1 minute'),
        ('due-2', 'c009000', 1000002, false, now() - interval '1 minute'),
        ('due-3', 'c019999', 1000003, false, now() - interval '5 minute'),
        ('burned', 'c000200', 1000004, true, now() - interval '1 minute');
    `);
    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    );
    for (const statement of statements(migration)) {
      await s.db.query(statement);
    }
    await s.db.query('ANALYZE "ChatConversation"');
    await s.db.query('ANALYZE "ChatMessage"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('finds exactly the conversations with expired live messages, after the cursor', async () => {
    const first = await sweepScan(null);
    const next = await sweepScan('c000100');
    const all = await s.db.query<{ id: string }>(first.sql, first.args);
    const after = await s.db.query<{ id: string }>(next.sql, next.args);

    expect(all.rows.map((row) => row.id)).toEqual([
      'c000100',
      'c009000',
      'c019999',
    ]);
    expect(after.rows.map((row) => row.id)).toEqual(['c009000', 'c019999']);
  });

  it('lets the planner range-scan the burn-due index on its own', async () => {
    const scan = await sweepScan(null);
    const plan = await explainPlan(s.db, scan.sql, scan.args);

    expect(plan).toContain('ChatMessage_burn_due_idx');
    expect(plan).not.toContain('Seq Scan');
  });
});
