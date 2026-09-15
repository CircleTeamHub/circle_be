import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl) {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.slice(1));
  if (process.env.NODE_ENV !== 'test' || !/(^|[_-])test($|[_-])/i.test(name)) {
    throw new Error(
      'Tombstone migration integration requires a test database and NODE_ENV=test',
    );
  }
}
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('chat tombstone migration PostgreSQL integration', () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl! });
    await client.connect();
  });
  afterAll(async () => {
    await client?.end();
  });

  it('backfills existing deleted rows into the mutation window and creates a valid index', async () => {
    await client.query('BEGIN');
    try {
      // A session-local table shadows the application table; rollback removes it.
      await client.query(`CREATE TEMP TABLE "ChatMessage" (
        "id" text PRIMARY KEY, "conversationID" text, "deleted" boolean
      ) ON COMMIT DROP`);
      await client.query(`INSERT INTO "ChatMessage" VALUES
        ('deleted-before-deploy', 'conversation', true),
        ('still-visible', 'conversation', false)`);
      await client.query(
        readFileSync(
          join(
            __dirname,
            '../prisma/migrations/20260913001000_add_chat_message_deleted_at/migration.sql',
          ),
          'utf8',
        ),
      );
      const tombstones = await client.query(`SELECT "id" FROM "ChatMessage"
        WHERE "deleted" = true AND "deletedAt" >= CURRENT_TIMESTAMP`);
      expect(tombstones.rows).toEqual([{ id: 'deleted-before-deploy' }]);
      const live = await client.query(
        `SELECT "deletedAt" FROM "ChatMessage" WHERE "id" = 'still-visible'`,
      );
      expect(live.rows).toEqual([{ deletedAt: null }]);
      const index = await client.query(`SELECT indisvalid FROM pg_index
        WHERE indexrelid = 'pg_temp."ChatMessage_conversationID_deletedAt_idx"'::regclass`);
      expect(index.rows).toEqual([{ indisvalid: true }]);
    } finally {
      await client.query('ROLLBACK');
    }
  });
});
