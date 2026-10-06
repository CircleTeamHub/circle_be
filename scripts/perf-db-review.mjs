#!/usr/bin/env node

/**
 * Seed a disposable, tagged notification slice and measure the database hot
 * paths reviewed in this branch. The tagged rows are always removed in the
 * finally block, so the script is safe to rerun against the local development
 * database.
 *
 * Run explicitly with:
 *   PERF_DB_REVIEW=1 npm run perf:db-review
 *
 * The local-database guard is intentional. Set ALLOW_NON_LOCAL_PERF_DB=1 only
 * for an intentional isolated database run. Never point this at production.
 */

import { performance } from 'node:perf_hooks';
import { Client } from 'pg';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_ROWS = 25_000;
const PAGE_SIZE = 20;
const SAMPLE_REPETITIONS = 5;

function isTruthy(value) {
  return /^(1|true|yes)$/i.test(String(value ?? ''));
}

function loadDevelopmentDatabaseUrl(env = process.env) {
  if (env.DATABASE_URL) return env.DATABASE_URL;

  const envPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '.env.development',
  );
  if (!fs.existsSync(envPath)) return undefined;
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split('\n')
    .find((entry) => /^DATABASE_URL\s*=/.test(entry));
  if (!line) return undefined;

  return line
    .slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

function isLocalDatabaseUrl(databaseUrl) {
  if (!databaseUrl) return false;
  try {
    const parsed = new URL(databaseUrl);
    return new Set(['localhost', '127.0.0.1', '[::1]']).has(parsed.hostname);
  } catch {
    return false;
  }
}

export function assertAllowed(env, databaseUrl) {
  if (!isTruthy(env.PERF_DB_REVIEW)) {
    throw new Error(
      'Refusing to run the database review. Set PERF_DB_REVIEW=1 for an explicit disposable-data run.',
    );
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the database review with NODE_ENV=production.',
    );
  }
  if (
    !isTruthy(env.ALLOW_NON_LOCAL_PERF_DB) &&
    !isLocalDatabaseUrl(databaseUrl)
  ) {
    throw new Error(
      'Refusing to run the database review against a non-local DATABASE_URL. Set ALLOW_NON_LOCAL_PERF_DB=1 only for an intentional isolated run.',
    );
  }
}

function parseRows(value) {
  const rows = Number.parseInt(String(value ?? DEFAULT_ROWS), 10);
  if (!Number.isInteger(rows) || rows < 100 || rows > 1_000_000) {
    throw new Error(
      'PERF_DB_REVIEW_ROWS must be an integer between 100 and 1000000',
    );
  }
  return rows;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))
  ];
}

async function timedQuery(
  client,
  text,
  values,
  repetitions = SAMPLE_REPETITIONS,
) {
  // Warm the plan/cache before reporting timings.
  await client.query(text, values);
  const durations = [];
  let rowCount = 0;
  for (let index = 0; index < repetitions; index += 1) {
    const started = performance.now();
    const result = await client.query(text, values);
    durations.push(performance.now() - started);
    rowCount = result.rowCount ?? 0;
  }
  return {
    repetitions,
    rowCount,
    minMs: Number(Math.min(...durations).toFixed(3)),
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    maxMs: Number(Math.max(...durations).toFixed(3)),
  };
}

async function explain(client, text, values) {
  const result = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
    values,
  );
  const payload = result.rows[0]?.['QUERY PLAN']?.[0];
  if (!payload) throw new Error('PostgreSQL returned no EXPLAIN plan');
  return {
    executionMs: Number(Number(payload['Execution Time']).toFixed(3)),
    planningMs: Number(Number(payload['Planning Time']).toFixed(3)),
    plan: payload.Plan,
  };
}

async function main() {
  const databaseUrl = loadDevelopmentDatabaseUrl(process.env);
  assertAllowed(process.env, databaseUrl);
  const rows = parseRows(process.env.PERF_DB_REVIEW_ROWS);
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = `perf-db-review:${runId}`;
  const idPrefix = `${marker}:`;
  const client = new Client({ connectionString: databaseUrl });

  await client.connect();
  try {
    const userResult = await client.query(
      'SELECT "id" FROM "User" ORDER BY "createdAt", "id" LIMIT 1',
    );
    const userId = userResult.rows[0]?.id;
    if (!userId)
      throw new Error(
        'No User row exists; seed a local development account first',
      );

    await client.query(
      `INSERT INTO "Notification"
        ("id", "content", "deleted", "read", "type", "toUserID", "fromUserID", "createdAt", "updatedAt")
       SELECT $1 || i::text,
              $2 || ':' || i::text,
              false,
              (i % 7 = 0),
              'SYSTEM'::"NotificationType",
              $3,
              $3,
              NOW() - make_interval(secs => i),
              NOW() - make_interval(secs => i)
       FROM generate_series(0, $4::int - 1) AS series(i)`,
      [idPrefix, marker, userId, rows],
    );
    // A production insert workload would update PostgreSQL statistics through
    // autovacuum. Refresh them here so EXPLAIN sees the synthetic cardinality
    // and does not choose a plan based on the pre-seed row count.
    await client.query('ANALYZE "Notification"');

    const cursorResult = await client.query(
      `SELECT "createdAt", "id"
       FROM "Notification"
       WHERE "content" LIKE $1
       ORDER BY "createdAt" DESC, "id" DESC
       OFFSET $2::int LIMIT 1`,
      [`${marker}:%`, Math.floor(rows * 0.8)],
    );
    const cursor = cursorResult.rows[0];
    if (!cursor) throw new Error('Unable to select a deep notification cursor');

    const offsetSql = `
      SELECT n."id", n."createdAt"
      FROM "Notification" n
      WHERE n."toUserID" = $1
        AND n."deleted" = false
        AND n."type" = 'SYSTEM'::"NotificationType"
      ORDER BY n."createdAt" DESC, n."id" DESC
      OFFSET $2::int LIMIT ${PAGE_SIZE}`;
    const keysetSql = `
      SELECT n."id", n."createdAt"
      FROM "Notification" n
      WHERE n."toUserID" = $1
        AND n."deleted" = false
        AND n."type" = 'SYSTEM'::"NotificationType"
        AND (n."createdAt", n."id") < ($2::timestamptz, $3::text)
      ORDER BY n."createdAt" DESC, n."id" DESC
      LIMIT ${PAGE_SIZE + 1}`;
    const circleSyncSql = `
      SELECT "circleID", "updatedAt"
      FROM "CircleMember"
      WHERE "updatedAt" > NOW() - INTERVAL '30 days'
      ORDER BY "updatedAt", "circleID"
      LIMIT 10000`;
    const pushFanoutSql = `
      WITH ranked AS (
        SELECT d."userID", d."token", d."provider",
               ROW_NUMBER() OVER (
                 PARTITION BY d."userID", d."provider"
                 ORDER BY d."updatedAt" DESC, d."id" DESC
               ) AS token_rank
        FROM "DevicePushToken" d
        WHERE d."userID" = $1
          AND d."disabledAt" IS NULL
          AND d."provider" IN ('expo', 'jpush')
      )
      SELECT "userID", "token", "provider"
      FROM ranked
      WHERE token_rank <= 20`;
    const chatListSql = `
      SELECT c."id", c."lastMessageAt"
      FROM "ChatMember" m
      JOIN "ChatConversation" c ON c."id" = m."conversationID"
      WHERE m."userID" = $1
        AND m."leftAt" IS NULL
        AND m."hiddenAt" IS NULL
      ORDER BY m."pinned" DESC, c."lastMessageAt" DESC NULLS LAST, c."id" DESC
      LIMIT 50`;

    const params = [userId, cursor.createdAt, cursor.id];
    const benchmarks = {
      notificationOffset: await timedQuery(client, offsetSql, [
        userId,
        Math.floor(rows * 0.8),
      ]),
      notificationKeyset: await timedQuery(client, keysetSql, params),
      circleMemberSync: await timedQuery(client, circleSyncSql, []),
      pushTokenFanout: await timedQuery(client, pushFanoutSql, [userId]),
      chatConversationList: await timedQuery(client, chatListSql, [userId]),
    };
    const explains = {
      notificationOffset: await explain(client, offsetSql, [
        userId,
        Math.floor(rows * 0.8),
      ]),
      notificationKeyset: await explain(client, keysetSql, params),
      circleMemberSync: await explain(client, circleSyncSql, []),
      pushTokenFanout: await explain(client, pushFanoutSql, [userId]),
      chatConversationList: await explain(client, chatListSql, [userId]),
    };

    console.log(
      JSON.stringify(
        {
          runId,
          rows,
          userId,
          cursorOffset: Math.floor(rows * 0.8),
          benchmarks,
          explains,
        },
        null,
        2,
      ),
    );
  } finally {
    await client.query('DELETE FROM "Notification" WHERE "id" LIKE $1', [
      `${idPrefix}%`,
    ]);
    await client.end();
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
