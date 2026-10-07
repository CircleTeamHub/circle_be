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
  let partialSql: string;
  const createFullSql = readFileSync(
    join(
      __dirname,
      '../prisma/migrations/20261007010000_cover_all_admin_post_search/migration.sql',
    ),
    'utf8',
  );
  const dropPartialSql = readFileSync(
    join(
      __dirname,
      '../prisma/migrations/20261007010100_drop_redundant_partial_post_search/migration.sql',
    ),
    'utf8',
  );
  const applyCorrections = async () => {
    await client.query(createFullSql);
    await client.query(dropPartialSql);
  };
  const indexState = async (name: string) => {
    const result = await client.query<{
      indisvalid: boolean;
      indisready: boolean;
    }>(
      `SELECT i.indisvalid, i.indisready
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    return result.rows[0];
  };
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
    partialSql = partial!;
    await client.query('ANALYZE "CirclePost"');
  });

  beforeEach(async () => {
    await client.query(
      `DROP INDEX IF EXISTS "${schema}"."CirclePost_content_admin_trgm_idx"`,
    );
    await client.query(
      `DROP INDEX IF EXISTS "${schema}"."CirclePost_content_trgm_idx"`,
    );
    await client.query(partialSql);
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
    await applyCorrections();
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

  it('blocks an interrupted concurrent build retry until its invalid artifact is removed', async () => {
    const blocker = new Client({ connectionString: databaseUrl! });
    const builder = new Client({ connectionString: databaseUrl! });
    let builderPid: number | undefined;
    let building: Promise<unknown> | undefined;
    try {
      await blocker.connect();
      await builder.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        `UPDATE "${schema}"."CirclePost" SET "content" = "content" WHERE "id" = '1'`,
      );
      await builder.query(`SET search_path TO "${schema}", public`);
      await builder.query("SET statement_timeout TO '10s'");
      const pid = await builder.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      builderPid = pid.rows[0].pid;
      building = builder.query(createFullSql).catch((error: unknown) => error);
      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const progress = await client.query<{ phase: string }>(
          'SELECT phase FROM pg_stat_progress_create_index WHERE pid = $1',
          [builderPid],
        );
        if (progress.rows[0]?.phase === 'waiting for writers before build') {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(waiting).toBe(true);
      await client.query('SELECT pg_cancel_backend($1)', [builderPid]);
      expect(await building).toMatchObject({ code: '57014' });
    } finally {
      try {
        if (builderPid !== undefined)
          await client.query('SELECT pg_cancel_backend($1)', [builderPid]);
        await building;
        await blocker.query('ROLLBACK');
      } finally {
        await Promise.all([blocker.end(), builder.end()]);
      }
    }

    expect(await indexState('CirclePost_content_admin_trgm_idx')).toEqual({
      indisvalid: false,
      indisready: false,
    });
    await expect(applyCorrections()).rejects.toMatchObject({ code: '42P07' });
    expect(await indexState('CirclePost_content_trgm_idx')).toEqual({
      indisvalid: true,
      indisready: true,
    });
    expect(await indexState('CirclePost_content_admin_trgm_idx')).toEqual({
      indisvalid: false,
      indisready: false,
    });

    // Operator recovery: remove the failed artifact, then rerun deployment.
    await client.query(
      `DROP INDEX CONCURRENTLY "${schema}"."CirclePost_content_admin_trgm_idx"`,
    );
    await applyCorrections();
    expect(await indexState('CirclePost_content_admin_trgm_idx')).toEqual({
      indisvalid: true,
      indisready: true,
    });
    expect(await indexState('CirclePost_content_trgm_idx')).toBeUndefined();
    expect(await explain()).toContain('CirclePost_content_admin_trgm_idx');
  });

  it('also blocks a valid existing index so an operator must verify and resolve the migration', async () => {
    await client.query(createFullSql);
    expect(await indexState('CirclePost_content_admin_trgm_idx')).toEqual({
      indisvalid: true,
      indisready: true,
    });
    await expect(applyCorrections()).rejects.toMatchObject({ code: '42P07' });
    expect(await indexState('CirclePost_content_trgm_idx')).toEqual({
      indisvalid: true,
      indisready: true,
    });
    // After verifying the completed full index, migrate resolve --applied
    // permits deploy to continue with only the next migration.
    await client.query(dropPartialSql);
    expect(await indexState('CirclePost_content_trgm_idx')).toBeUndefined();
    expect(await indexState('CirclePost_content_admin_trgm_idx')).toEqual({
      indisvalid: true,
      indisready: true,
    });
  });
});
