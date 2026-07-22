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

echo "==> 1/5 Simulate the existing baseline schema without migration history"
npx prisma db execute --file prisma/migrations/0_init/migration.sql

echo "==> 2/5 Reproduce the archived-chain GroupSyncOutbox index"
# Exact definition from archived migration 20260608020000.
npx prisma db execute --stdin <<'SQL'
CREATE UNIQUE INDEX "GroupSyncOutbox_open_active_key"
ON "GroupSyncOutbox"("operation", "groupID", "userID")
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
SQL

echo "==> 3/5 Apply the documented runbook: mark the squashed baseline as already-applied"
# Records 0_init as applied WITHOUT running its SQL again.
npx prisma migrate resolve --applied 0_init

echo "==> 4/5 Deploy the remaining pending migrations onto the existing database"
# Every post-baseline schema/data migration runs exactly once here.
npx prisma migrate deploy

echo "==> 5/5 Assert desired-state index compatibility and no schema drift"
npx prisma db execute --stdin <<'SQL'
DO $$
DECLARE
  key_columns text[];
BEGIN
  SELECT ARRAY(
    SELECT attribute.attname
    FROM unnest(index_meta.indkey::smallint[]) WITH ORDINALITY AS key(attnum, position)
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = index_meta.indrelid
     AND attribute.attnum = key.attnum
    WHERE key.position <= index_meta.indnkeyatts
    ORDER BY key.position
  )
  INTO key_columns
  FROM pg_catalog.pg_index AS index_meta
  WHERE index_meta.indexrelid = '"GroupSyncOutbox_open_active_key"'::regclass
    AND index_meta.indisunique
    AND index_meta.indisvalid
    AND pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid)
      LIKE '%PENDING%PROCESSING%FAILED%';

  IF key_columns IS DISTINCT FROM ARRAY['groupID', 'userID']::text[] THEN
    RAISE EXCEPTION 'Unexpected desired-state index columns: %', key_columns;
  END IF;
END
$$;
SQL
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code

echo "✅ Existing-DB baseline-reset runbook verified end-to-end (incl. post-0_init migrations)."
