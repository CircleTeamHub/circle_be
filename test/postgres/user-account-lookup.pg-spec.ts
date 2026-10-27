import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeUserIdByAccountIdQuery } from 'src/user/user-account-lookup.query';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';

/**
 * 账号号码精确查找(GET /user/search/account)在真 PostgreSQL 上的口径与成本:
 * - 大小写不敏感,但 `_` / `%` 只是普通字符 —— 原来的 mode:'insensitive' 编译成
 *   ILIKE,`a_b` 能命中 `axb`,单个 `%` 能命中任意一个人;
 * - 只认 ACTIVE;
 * - 走函数式唯一索引 User_accountId_lower_key(迁移 20260623010000)。
 */
const LOWER_INDEX_MIGRATION = '20260623010000_account_id_lower_unique';

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('exact account lookup (PostgreSQL)', () => {
  let s: IsolatedSchema;

  const lookup = async (accountId: string) => {
    const q = activeUserIdByAccountIdQuery(accountId);
    const { rows } = await s.db.query<{ id: string }>(q.text, q.values);
    return rows.map((row) => row.id);
  };

  beforeAll(async () => {
    s = await openIsolatedSchema('account_lookup');
    await s.db.query(`
      CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED', 'DELETED');
      CREATE TABLE "User" (
        id text PRIMARY KEY, "accountId" text NOT NULL,
        status "UserStatus" NOT NULL DEFAULT 'ACTIVE'
      );
      CREATE UNIQUE INDEX "User_accountId_key" ON "User"("accountId");
      INSERT INTO "User" (id, "accountId", status) VALUES
        ('u-axb', 'axb', 'ACTIVE'),
        ('u-a-b', 'a_b', 'ACTIVE'),
        ('u-jimmy', 'jimmy', 'ACTIVE'),
        ('u-banned', 'gone', 'BANNED');
      INSERT INTO "User" (id, "accountId")
      SELECT 'filler-' || g, 'acct' || g FROM generate_series(1, 20000) g;
    `);
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations',
        LOWER_INDEX_MIGRATION,
        'migration.sql',
      ),
      'utf8',
    );
    for (const statement of statements(migration)) {
      await s.db.query(statement);
    }
    await s.db.query('ANALYZE "User"');
  });

  afterAll(async () => {
    await s?.close();
  });

  it('treats _ and % as literal characters, unlike the old ILIKE', async () => {
    // 旧写法的行为:ILIKE 把 _ 当单字符通配符、% 当任意串。
    const ilike = await s.db.query<{ id: string }>(
      `SELECT id FROM "User" WHERE "accountId" ILIKE $1 AND status = 'ACTIVE' ORDER BY id`,
      ['a_b'],
    );
    expect(ilike.rows.map((row) => row.id)).toEqual(['u-a-b', 'u-axb']);

    expect(await lookup('a_b')).toEqual(['u-a-b']);
    expect(await lookup('A_B')).toEqual(['u-a-b']);
    expect(await lookup('a%')).toEqual([]);
    expect(await lookup('%')).toEqual([]);
    expect(await lookup('_____')).toEqual([]);
  });

  it('matches case-insensitively and only ACTIVE accounts', async () => {
    expect(await lookup('JiMmY')).toEqual(['u-jimmy']);
    expect(await lookup('axb')).toEqual(['u-axb']);
    expect(await lookup('gone')).toEqual([]);
    expect(await lookup('nobody')).toEqual([]);
  });

  it('probes the lower(accountId) unique index', async () => {
    const q = activeUserIdByAccountIdQuery('JiMmY');
    const plan = await explainPlan(s.db, q.text, q.values);

    expect(plan).toContain('User_accountId_lower_key');
    expect(plan).not.toContain('Seq Scan');
  });
});
