#!/usr/bin/env bash
#
# Verifies the EXISTING-database baseline-reset runbook in docs/migration-baseline.md.
#
# The fresh-DB path is already gated by the `migrations_e2e` CI job (deploy from
# empty + drift check). This script covers the other half — the path that the
# 0_init squash actually puts at risk: a long-lived database whose schema was
# built incrementally (originally via `db push`) and whose `_prisma_migrations`
# does NOT contain `0_init`. On such a database a naive `migrate deploy` aborts,
# because 0_init re-issues CREATE TABLE/TYPE for objects that already exist.
#
# We reproduce the post-squash baseline state by executing 0_init's SQL without
# recording migration history, then run the documented resolve/deploy runbook.
#
# Usage: DATABASE_URL=postgres://... bash scripts/verify-migration-baseline.sh
# DATABASE_URL MUST point at a disposable database — this script mutates it.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point at a disposable Postgres database}"

echo "==> 1/7 Simulate the existing baseline schema without migration history"
npx prisma db execute --file prisma/migrations/0_init/migration.sql

echo "==> 2/7 Seed malformed legacy index and chronological desired-state cases"
npx prisma db execute --stdin <<'SQL'
INSERT INTO "GroupSyncOutbox"
  ("id", "operation", "status", "groupID", "userID", "lockedAt", "createdAt", "updatedAt")
VALUES
  (
    'migration-add', 'ADD_MEMBER', 'PROCESSING', 'migration-group', 'migration-user',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes',
    CURRENT_TIMESTAMP - INTERVAL '2 minutes',
    CURRENT_TIMESTAMP - INTERVAL '2 minutes'
  ),
  (
    'migration-remove', 'REMOVE_MEMBER', 'COMPLETED', 'migration-group', 'migration-user',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '1 minute',
    CURRENT_TIMESTAMP - INTERVAL '1 minute'
  ),
  (
    'inverse-remove', 'REMOVE_MEMBER', 'PROCESSING', 'inverse-group', 'inverse-user',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes',
    CURRENT_TIMESTAMP - INTERVAL '2 minutes',
    CURRENT_TIMESTAMP - INTERVAL '2 minutes'
  ),
  (
    'inverse-add', 'ADD_MEMBER', 'COMPLETED', 'inverse-group', 'inverse-user',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '1 minute',
    CURRENT_TIMESTAMP - INTERVAL '1 minute'
  ),
  (
    'tie-a-processing', 'ADD_MEMBER', 'PROCESSING', 'tie-group', 'tie-user',
    CURRENT_TIMESTAMP - INTERVAL '10 minutes',
    CURRENT_TIMESTAMP - INTERVAL '1 minute',
    CURRENT_TIMESTAMP - INTERVAL '1 minute'
  ),
  (
    'tie-z-desired', 'REMOVE_MEMBER', 'COMPLETED', 'tie-group', 'tie-user',
    NULL,
    CURRENT_TIMESTAMP - INTERVAL '1 minute',
    CURRENT_TIMESTAMP - INTERVAL '1 minute'
  );

CREATE UNIQUE INDEX "GroupSyncOutbox_open_active_key"
ON "GroupSyncOutbox"("groupID", "userID")
WHERE "status" = 'PENDING';
SQL

echo "==> 3/7 Assert malformed-index failure rolls back every migration mutation"
if migration_output=$(npx prisma db execute \
  --file prisma/migrations/20260722010000_restore_group_sync_outbox_idempotency/migration.sql \
  2>&1); then
  echo "Expected malformed GroupSyncOutbox index migration to fail" >&2
  exit 1
fi
if [[ "$migration_output" != *"Unexpected definition for index GroupSyncOutbox_open_active_key"* ]]; then
  printf '%s\n' "$migration_output" >&2
  exit 1
fi
npx prisma db execute --stdin <<'SQL'
DO $$
DECLARE
  unchanged_rows integer;
  probe_count integer;
  state_column_count integer;
  malformed_definition text;
BEGIN
  SELECT COUNT(*)
  INTO unchanged_rows
  FROM "GroupSyncOutbox"
  WHERE ("id" = 'migration-add' AND "status" = 'PROCESSING')
     OR ("id" = 'migration-remove' AND "status" = 'COMPLETED')
     OR ("id" = 'inverse-remove' AND "status" = 'PROCESSING')
     OR ("id" = 'inverse-add' AND "status" = 'COMPLETED')
     OR ("id" = 'tie-a-processing' AND "status" = 'PROCESSING')
     OR ("id" = 'tie-z-desired' AND "status" = 'COMPLETED');

  SELECT COUNT(*)
  INTO probe_count
  FROM pg_catalog.pg_class AS index_class
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = index_class.relnamespace
  WHERE namespace.nspname = current_schema()
    AND index_class.relname LIKE '__GroupSyncOutbox_%_probe_20260722010000';

  SELECT pg_catalog.pg_get_indexdef('"GroupSyncOutbox_open_active_key"'::regclass)
  INTO malformed_definition;

  SELECT COUNT(*)
  INTO state_column_count
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'GroupSyncOutbox'
    AND column_name IN ('generation', 'processingGeneration', 'processingOperation');

  IF unchanged_rows <> 6
     OR probe_count <> 0
     OR state_column_count <> 0
     OR malformed_definition NOT LIKE '%("groupID", "userID")%'
     OR malformed_definition NOT LIKE '%PENDING%'
     OR malformed_definition LIKE '%PROCESSING%' THEN
    RAISE EXCEPTION
      'Malformed-index rollback failed: rows=%, probes=%, columns=%, index=%',
      unchanged_rows, probe_count, state_column_count, malformed_definition;
  END IF;
END
$$;
SQL

echo "==> 4/7 Replace only the malformed input with the archived-chain index"
npx prisma db execute --stdin <<'SQL'
DROP INDEX "GroupSyncOutbox_open_active_key";
-- Exact definition from archived migration 20260608020000.
CREATE UNIQUE INDEX "GroupSyncOutbox_open_active_key"
ON "GroupSyncOutbox"("operation", "groupID", "userID")
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
SQL

echo "==> 5/7 Apply the documented runbook: mark the squashed baseline as already-applied"
# Records 0_init as applied WITHOUT running its SQL again.
npx prisma migrate resolve --applied 0_init

echo "==> 6/7 Deploy the remaining pending migrations onto the existing database"
# Every post-baseline schema/data migration runs exactly once here.
npx prisma migrate deploy

echo "==> 7/7 Assert the OpenIM outbox teardown landed and no schema drift"
# 20260806000000_drop_openim_sync_outbox 拆掉了三张 OpenIM 同步 outbox 表,所以
# 这一步不再断言 GroupSyncOutbox 的 desired-state 行/索引 —— deploy 跑完它们
# 已经不存在了。20260722010000 的索引修复语义仍由 3/7、4/7 在 deploy 之前覆盖;
# 它在真实链路里的重放安全性由 6/7 的 deploy 成功本身证明。
npx prisma db execute --stdin <<'SQL'
DO $$
DECLARE
  leftover_tables text[];
  leftover_column integer;
BEGIN
  SELECT ARRAY(
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN (
        'GroupSyncOutbox', 'FriendSyncOutbox', 'UserProfileSyncOutbox'
      )
    ORDER BY table_name
  )
  INTO leftover_tables;

  SELECT COUNT(*)
  INTO leftover_column
  FROM information_schema.columns
  WHERE table_schema = current_schema()
    AND table_name = 'User'
    AND column_name = 'openimSynced';

  IF leftover_tables <> ARRAY[]::text[] OR leftover_column <> 0 THEN
    RAISE EXCEPTION
      'OpenIM outbox teardown incomplete: tables=%, User.openimSynced columns=%',
      leftover_tables, leftover_column;
  END IF;
END
$$;
SQL
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code

echo "✅ Existing-DB baseline-reset runbook verified end-to-end (incl. post-0_init migrations)."
