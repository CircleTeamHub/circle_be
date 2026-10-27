import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dueTempChatsQuery } from 'src/temp-chat/temp-chat-cleanup.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 临时房每分钟的清理认领在真 PostgreSQL 上的口径与成本:到期的 ACTIVE 房间走
 * (status, expiresAt),已结束待清理的房间走 20261026000320 的部分索引 —— 清理完的
 * 历史房间(TempChat 从不删行)一行都不碰;两支合并后仍按 expiresAt 升序、共用上限。
 */
const MIGRATION = '20261026000320_temp_chat_pending_cleanup_index';

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('temp chat cleanup claim (PostgreSQL)', () => {
  let s: IsolatedSchema;
  const now = new Date('2026-10-26T12:00:00.000Z');
  const stale = new Date(now.getTime() - 2 * 60 * 1000);

  const claim = async (limit = 200) => {
    const q = dueTempChatsQuery(now, stale, limit);
    const { rows } = await s.db.query<{ id: string; groupId: string }>(
      q.text,
      q.values,
    );
    return rows.map((row) => row.id);
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('temp_chat_cleanup');
    await s.db.query(`
      CREATE TYPE "TempChatStatus" AS ENUM ('ACTIVE', 'ENDED', 'EXPIRED');
      CREATE TABLE "TempChat" (
        id text PRIMARY KEY, "groupId" text NOT NULL UNIQUE,
        status "TempChatStatus" NOT NULL DEFAULT 'ACTIVE',
        "expiresAt" timestamp(3) NOT NULL,
        "cleanupLockedAt" timestamp(3), "cleanupCompletedAt" timestamp(3)
      );
      CREATE INDEX "TempChat_status_expiresAt_idx" ON "TempChat"(status, "expiresAt");
    `);
    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    );
    for (const statement of statements(migration)) {
      await s.db.query(statement);
    }
    // 4 万间清理完的历史房间:旧写法的第二支每分钟都要把它们扫一遍。
    await s.db.query(`
      INSERT INTO "TempChat" (id, "groupId", status, "expiresAt", "cleanupCompletedAt")
      SELECT 'done-' || g, 'g-done-' || g,
             (CASE WHEN g % 2 = 0 THEN 'ENDED' ELSE 'EXPIRED' END)::"TempChatStatus",
             TIMESTAMP '2026-01-01' + g * INTERVAL '1 minute',
             TIMESTAMP '2026-01-01' + g * INTERVAL '1 minute'
      FROM generate_series(1, 40000) g;
      -- 还没到期的活房间。
      INSERT INTO "TempChat" (id, "groupId", status, "expiresAt")
      SELECT 'live-' || g, 'g-live-' || g, 'ACTIVE', TIMESTAMP '2026-10-27' + g * INTERVAL '1 minute'
      FROM generate_series(1, 500) g;
    `);
    await s.db.query(
      `INSERT INTO "TempChat" (id, "groupId", status, "expiresAt", "cleanupLockedAt", "cleanupCompletedAt") VALUES
        ('active-due-old', 'g1', 'ACTIVE', '2026-10-26T10:00:00', NULL, NULL),
        ('active-due-new', 'g2', 'ACTIVE', '2026-10-26T11:59:00', NULL, NULL),
        ('active-due-now', 'g3', 'ACTIVE', $1, NULL, NULL),
        ('ended-unlocked', 'g4', 'ENDED', '2026-10-26T10:30:00', NULL, NULL),
        ('expired-stale', 'g5', 'EXPIRED', '2026-10-26T09:00:00', '2026-10-26T11:50:00', NULL),
        ('ended-fresh-lease', 'g6', 'ENDED', '2026-10-26T08:00:00', '2026-10-26T11:59:30', NULL),
        ('expired-done', 'g7', 'EXPIRED', '2026-10-26T07:00:00', NULL, '2026-10-26T07:01:00')`,
      [now],
    );
    await s.db.query('ANALYZE "TempChat"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('claims exactly what the old OR claimed, oldest expiry first', async () => {
    expect(await claim()).toEqual([
      'expired-stale',
      'active-due-old',
      'ended-unlocked',
      'active-due-new',
      'active-due-now',
    ]);
  });

  it('applies one shared cap after merging both branches', async () => {
    expect(await claim(2)).toEqual(['expired-stale', 'active-due-old']);
  });

  it('reads each branch through its own index and never scans finished rooms', async () => {
    const q = dueTempChatsQuery(now, stale, 200);
    const plan = await explainPlan(s.db, q.text, q.values);

    expect(plan).toContain('TempChat_status_expiresAt_idx');
    expect(plan).toContain('TempChat_pending_cleanup_expiresAt_idx');
    expect(plan).not.toContain('Seq Scan');
  });
});
