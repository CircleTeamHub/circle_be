import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const MIGRATION = '20260913001000_add_chat_message_deleted_at';
const INDEX = 'ChatMessage_conversationID_deletedAt_idx';
const BATCH_SIZE = 5000;

async function tableExists(client, table) {
  const result = await client.query('SELECT to_regclass($1) AS relation', [
    `"${table}"`,
  ]);
  return result.rows[0]?.relation != null;
}

async function migrationAlreadyApplied(client) {
  const result = await client.query(
    `SELECT 1
       FROM "_prisma_migrations"
      WHERE migration_name = $1
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
      LIMIT 1`,
    [MIGRATION],
  );
  return result.rowCount > 0;
}

async function readIndex(client) {
  const result = await client.query(
    `SELECT i.indisvalid,
            pg_get_indexdef(i.indexrelid) AS definition
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = current_schema()
        AND c.relname = $1`,
    [INDEX],
  );
  return result.rows[0] ?? null;
}

function isExpectedIndex(index) {
  if (!index?.indisvalid || typeof index.definition !== 'string') return false;
  return new RegExp(
    `CREATE INDEX "?${INDEX}"? ON .*"ChatMessage".*\\("conversationID", "deletedAt"\\)$`,
    'i',
  ).test(index.definition);
}

async function verifyPreparedSchema(client) {
  const column = await client.query(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'ChatMessage'
        AND column_name = 'deletedAt'`,
  );
  if (column.rows[0]?.data_type !== 'timestamp without time zone') {
    throw new Error(
      'ChatMessage.deletedAt is missing or has an unexpected type',
    );
  }

  const remaining = await client.query(
    `SELECT 1 FROM "ChatMessage"
      WHERE "deleted" = true AND "deletedAt" IS NULL
      LIMIT 1`,
  );
  if (remaining.rowCount > 0) {
    throw new Error('ChatMessage deletedAt backfill is incomplete');
  }

  const index = await readIndex(client);
  if (!isExpectedIndex(index)) {
    throw new Error(
      `${INDEX} is missing, invalid, or has an unexpected definition`,
    );
  }
}

export async function prepareMigration(client, onPrepared) {
  await client.query(
    `SELECT pg_advisory_lock(hashtext('prepare-chat-message-deleted-at-migration'))`,
  );
  try {
    const hasMigrationHistory = await tableExists(client, '_prisma_migrations');
    if (hasMigrationHistory && (await migrationAlreadyApplied(client))) {
      return { prepared: false, reason: 'already-applied' };
    }
    if (!(await tableExists(client, 'ChatMessage'))) {
      // Fresh database: the released migration will run while the table is empty.
      return { prepared: false, reason: 'fresh-database' };
    }
    if (!hasMigrationHistory) {
      throw new Error(
        'ChatMessage exists but Prisma migration history is missing; baseline the database before deployment',
      );
    }

    await client.query(
      `ALTER TABLE "ChatMessage"
       ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3)`,
    );

    const preparedAt = new Date();
    let updated = 0;
    for (;;) {
      // Each query is its own transaction. Locks and WAL are released after every
      // bounded batch instead of one transaction spanning the entire hot table.
      const batch = await client.query(
        `WITH batch AS (
           SELECT "id"
             FROM "ChatMessage"
            WHERE "deleted" = true AND "deletedAt" IS NULL
            ORDER BY "id"
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE "ChatMessage" AS message
            SET "deletedAt" = $2
           FROM batch
          WHERE message."id" = batch."id"
         RETURNING message."id"`,
        [BATCH_SIZE, preparedAt],
      );
      updated += batch.rowCount ?? 0;
      if ((batch.rowCount ?? 0) < BATCH_SIZE) break;
    }

    const existingIndex = await readIndex(client);
    if (existingIndex && !existingIndex.indisvalid) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${INDEX}"`);
    } else if (existingIndex && !isExpectedIndex(existingIndex)) {
      throw new Error(`${INDEX} exists with an unexpected definition`);
    }
    await client.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${INDEX}"
       ON "ChatMessage"("conversationID", "deletedAt")`,
    );
    await verifyPreparedSchema(client);
    // Keep the advisory lock until Prisma records the prepared migration. This
    // prevents two simultaneous deploy jobs from both trying to resolve it.
    if (onPrepared) await onPrepared();
    return { prepared: true, updated };
  } finally {
    await client.query(
      `SELECT pg_advisory_unlock(hashtext('prepare-chat-message-deleted-at-migration'))`,
    );
  }
}

function resolvePrismaMigration() {
  const prisma =
    process.platform === 'win32'
      ? './node_modules/.bin/prisma.cmd'
      : './node_modules/.bin/prisma';
  const result = spawnSync(
    prisma,
    ['migrate', 'resolve', '--applied', MIGRATION],
    { stdio: 'inherit', env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `prisma migrate resolve exited with status ${result.status}`,
    );
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  let result;
  try {
    result = await prepareMigration(client, resolvePrismaMigration);
  } finally {
    await client.end();
  }

  if (!result.prepared) {
    process.stdout.write(`deletedAt migration preparation: ${result.reason}\n`);
    return;
  }
  process.stdout.write(
    `deletedAt migration preparation: backfilled ${result.updated} rows\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(
      `deletedAt migration preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
