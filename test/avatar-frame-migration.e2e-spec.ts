import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

function allowlistedTestDatabaseUrl(): string | null {
  const databaseUrl =
    process.env.AVATAR_FRAME_MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) return null;
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      'Avatar-frame migration integration requires NODE_ENV=test',
    );
  }

  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !/(^|[_-])test($|[_-])/i.test(databaseName)
  ) {
    throw new Error(
      `Refusing avatar-frame migration integration on non-test database: ${databaseName}`,
    );
  }
  return databaseUrl;
}

const databaseUrl = allowlistedTestDatabaseUrl();
const describePostgres = databaseUrl ? describe : describe.skip;
const migrationPath = join(
  __dirname,
  '../prisma/migrations/20260729120000_avatar_frame_wardrobe/migration.sql',
);
const selectedIndexMigrationPath = join(
  __dirname,
  '../prisma/migrations/20260729120500_avatar_frame_selected_index/migration.sql',
);

describePostgres('avatar frame migration PostgreSQL integration', () => {
  const schemaName = `avatar_frame_migration_test_${randomUUID().replace(
    /-/g,
    '',
  )}`;
  const activeDiamondExpiry = new Date('2035-01-01T00:00:00.000Z');
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl! });
    await client.connect();
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    await client.query(`
      CREATE TABLE "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "avatarFrame" TEXT,
        "vipLevel" INTEGER NOT NULL DEFAULT 0,
        "vipExpiresAt" TIMESTAMP(3)
      )
    `);
    await client.query(
      `
        INSERT INTO "User" ("id", "vipLevel", "vipExpiresAt")
        VALUES
          ('ordinary', 2, $1),
          ('expired-diamond', 3, $2),
          ('active-diamond', 3, $1),
          ('lifetime-super', 4, $2)
      `,
      [activeDiamondExpiry, new Date('2020-01-01T00:00:00.000Z')],
    );

    await client.query(readFileSync(migrationPath, 'utf8'));
    const selectedIndexSql = readFileSync(
      selectedIndexMigrationPath,
      'utf8',
    ).replace(
      'ON "User"("selectedAvatarFrameID")',
      `ON "${schemaName}"."User"("selectedAvatarFrameID")`,
    );
    await client.query(selectedIndexSql);
  });

  afterAll(async () => {
    if (!client) return;
    try {
      // A migration failure can leave an explicit transaction aborted. Reset
      // it before dropping the isolated schema so cleanup still succeeds.
      await client.query('ROLLBACK');
      await client.query('SET search_path TO public');
      await client.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } finally {
      await client.end();
    }
  });

  it('applies the backfill, validated foreign key, and query-path indexes', async () => {
    const users = await client.query<{
      id: string;
      key: string | null;
      expiresAt: Date | null;
    }>(`
      SELECT
        u."id",
        frame."key",
        u."selectedAvatarFrameExpiresAt" AS "expiresAt"
      FROM "User" u
      LEFT JOIN "AvatarFrameAsset" frame
        ON frame."id" = u."selectedAvatarFrameID"
      ORDER BY u."id"
    `);
    expect(users.rows).toEqual([
      {
        id: 'active-diamond',
        key: 'membership-diamond',
        expiresAt: activeDiamondExpiry,
      },
      { id: 'expired-diamond', key: null, expiresAt: null },
      { id: 'lifetime-super', key: 'membership-super', expiresAt: null },
      { id: 'ordinary', key: null, expiresAt: null },
    ]);

    const constraints = await client.query<{
      conname: string;
      convalidated: boolean;
    }>(
      `
        SELECT constraint_row.conname, constraint_row.convalidated
        FROM pg_constraint constraint_row
        JOIN pg_namespace namespace_row
          ON namespace_row.oid = constraint_row.connamespace
        WHERE namespace_row.nspname = $1
          AND constraint_row.contype = 'f'
      `,
      [schemaName],
    );
    expect(
      constraints.rows.find(
        ({ conname }) => conname === 'User_selectedAvatarFrameID_fkey',
      ),
    ).toEqual({
      conname: 'User_selectedAvatarFrameID_fkey',
      convalidated: true,
    });

    const indexes = await client.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE schemaname = $1',
      [schemaName],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        'User_selectedAvatarFrameID_idx',
        'UserAvatarFrameGrant_user_active_idx',
        'UserAvatarFrameGrant_frame_active_idx',
        'UserAvatarFrameGrant_user_createdAt_id_idx',
      ]),
    );
  });
});
