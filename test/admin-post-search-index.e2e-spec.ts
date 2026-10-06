import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (
    process.env.NODE_ENV !== 'test' ||
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !/(^|[_-])test($|[_-])/i.test(decodeURIComponent(parsed.pathname.slice(1)))
  )
    throw new Error('Admin search index integration requires a test database');
}
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('admin post search corrective migrations', () => {
  const schema = `post_search_test_${randomUUID().replace(/-/g, '')}`;
  let client: Client;
  const explain = async (status = '') => {
    const result = await client.query(`EXPLAIN (FORMAT JSON)
      SELECT "id", "content" FROM "CirclePost"
      WHERE "content" ILIKE '%rare-search-needle%' ${status}
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 20`);
    return JSON.stringify(result.rows[0]['QUERY PLAN']);
  };

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl! });
    await client.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}", public`);
    await client.query(`CREATE TABLE "CirclePost" (
      "id" TEXT PRIMARY KEY, "content" TEXT NOT NULL,
      "status" TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now()
    )`);
    await client.query(`INSERT INTO "CirclePost" ("id", "content", "status")
      SELECT n::text, CASE WHEN n IN (1, 2) THEN 'rare-search-needle'
      ELSE 'ordinary post ' || md5(n::text) END,
      CASE WHEN n % 2 = 0 THEN 'DELETED' ELSE 'VISIBLE' END
      FROM generate_series(1, 10000) AS n`);
    const oldMigration = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20261005090300_add_trigram_search_indexes/migration.sql',
      ),
      'utf8',
    );
    const partial =
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "CirclePost_content_trgm_idx"[\s\S]*?;/.exec(
        oldMigration,
      )?.[0];
    expect(partial).toBeDefined();
    await client.query(partial!);
    await client.query('ANALYZE "CirclePost"');
  });

  afterAll(async () => {
    if (!client) return;
    try {
      await client.query('ROLLBACK');
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  });

  it('indexes default admin search including deleted posts without changing results', async () => {
    expect(await explain()).not.toContain('CirclePost_content_trgm_idx');
    const corrections = [
      readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20261007010000_cover_all_admin_post_search/migration.sql',
        ),
        'utf8',
      ),
      readFileSync(
        join(
          __dirname,
          '../prisma/migrations/20261007010100_drop_redundant_partial_post_search/migration.sql',
        ),
        'utf8',
      ),
    ];
    for (const sql of corrections) await client.query(sql);
    await client.query('ANALYZE "CirclePost"');
    expect(await explain()).toContain('CirclePost_content_admin_trgm_idx');
    expect(await explain(`AND "status" = 'VISIBLE'`)).toContain(
      'CirclePost_content_admin_trgm_idx',
    );
    const count = await client.query(`EXPLAIN (FORMAT JSON) SELECT COUNT(*)
      FROM "CirclePost" WHERE "content" ILIKE '%rare-search-needle%'`);
    expect(JSON.stringify(count.rows[0]['QUERY PLAN'])).toContain(
      'CirclePost_content_admin_trgm_idx',
    );
    const results = await client.query(`SELECT "status" FROM "CirclePost"
      WHERE "content" ILIKE '%rare-search-needle%' ORDER BY "id"`);
    expect(results.rows).toEqual([
      { status: 'VISIBLE' },
      { status: 'DELETED' },
    ]);
    const indexes = await client.query(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1',
      [schema],
    );
    expect(indexes.rows.map((row) => row.indexname)).not.toContain(
      'CirclePost_content_trgm_idx',
    );
  });
});
