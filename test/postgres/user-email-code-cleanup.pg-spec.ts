import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RefreshTokenCleanup } from 'src/auth/refresh-token.cleanup';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { RedisService } from 'src/redis/redis.service';
import {
  describePostgres,
  explainPlan,
  type IsolatedSchema,
  openIsolatedSchema,
} from './pg-test-db';
import { capturePrisma, captureQueries } from './prisma-sql-capture';

/**
 * 邮箱验证码清理(RefreshTokenCleanup 里的 pruneExpiredEmailCodes)与
 * 20261026000220 的 expiresAt 索引在真 PostgreSQL 上的口径与成本:
 * - 只取过期满一天的行,按 expiresAt 升序;
 * - 取批走 EmailVerificationCode_expiresAt_idx,索引直接给出顺序,没有 Sort ——
 *   首次上线时的历史积压也只读每批 1000 个索引项。
 *
 * 取批 SQL 是 RefreshTokenCleanup 用假 adapter 现场编译出来的(prisma-sql-capture)。
 */
const MIGRATION = '20261026000220_email_code_expiry_index';
const NOW = new Date('2026-10-14T12:00:00.000Z');

const statements = (sql: string): string[] =>
  sql
    .replace(/--.*$/gm, '')
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

describePostgres('email verification code cleanup (PostgreSQL)', () => {
  let s: IsolatedSchema;
  let batchQuery: { sql: string; args: unknown[] };

  beforeAll(async () => {
    s = await openIsolatedSchema('email_code_cleanup');
    await s.db.query(`
      CREATE TYPE "EmailCodePurpose" AS ENUM ('REGISTER', 'LOGIN', 'RESET_PASSWORD');
      CREATE TABLE "EmailVerificationCode" (
        id text PRIMARY KEY, email text NOT NULL, "codeHash" text NOT NULL,
        purpose "EmailCodePurpose" NOT NULL, "expiresAt" timestamp(3) NOT NULL,
        attempts integer NOT NULL DEFAULT 0, "consumedAt" timestamp(3),
        "createdAt" timestamp(3) NOT NULL DEFAULT now()
      );
      CREATE INDEX "EmailVerificationCode_email_purpose_idx"
        ON "EmailVerificationCode"(email, purpose);
      -- 一分钟一条,横跨 NOW 前后各约 35 天。
      INSERT INTO "EmailVerificationCode" (id, email, "codeHash", purpose, "expiresAt")
      SELECT 'code-' || g, 'user' || (g % 500) || '@example.com', 'hash', 'LOGIN',
             TIMESTAMP '2026-10-14 12:00:00' + (g - 50000) * INTERVAL '1 minute'
      FROM generate_series(1, 100000) g;
    `);
    const migration = readFileSync(
      join(process.cwd(), 'prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    );
    for (const statement of statements(migration)) {
      await s.db.query(statement);
    }
    await s.db.query('ANALYZE "EmailVerificationCode"');

    const capture = capturePrisma();
    // 没有 Redis lease(tryAcquireLease 回 undefined)时 sweep 直接跑。
    const redis = {
      tryAcquireLease: () => Promise.resolve(undefined),
      renewLease: () => Promise.resolve(true),
      releaseLease: () => Promise.resolve(undefined),
    } as unknown as RedisService;
    const cleanup = new RefreshTokenCleanup(
      capture.prisma as unknown as PrismaService,
      redis,
    );
    const queries = await captureQueries(capture.queries, () =>
      cleanup.sweep(NOW),
    );
    const found = queries.find((q) =>
      q.sql.includes('"EmailVerificationCode"'),
    );
    if (!found) throw new Error('email code batch query was not captured');
    batchQuery = found;
  });

  afterAll(async () => {
    await s?.close();
  });

  it('selects only codes expired for more than a day, oldest first', async () => {
    const { rows } = await s.db.query<{ id: string; expiresAt: Date }>(
      batchQuery.sql.replace(
        /SELECT .* FROM/,
        'SELECT "EmailVerificationCode"."id", "EmailVerificationCode"."expiresAt" FROM',
      ),
      batchQuery.args,
    );
    const cutoff = NOW.getTime() - 24 * 60 * 60 * 1000;

    expect(rows).toHaveLength(1000);
    expect(rows.every((row) => row.expiresAt.getTime() < cutoff)).toBe(true);
    const times = rows.map((row) => row.expiresAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(rows[0].id).toBe('code-1');
  });

  it('reads each batch straight off the expiresAt index without sorting', async () => {
    const plan = await explainPlan(s.db, batchQuery.sql, batchQuery.args);

    expect(plan).toContain('EmailVerificationCode_expiresAt_idx');
    expect(plan).not.toContain('"Sort"');
    expect(plan).not.toContain('Seq Scan');
  });
});
