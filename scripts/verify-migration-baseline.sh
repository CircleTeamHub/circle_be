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

echo "==> 1/4 Simulate the existing baseline schema without migration history"
npx prisma db execute --file prisma/migrations/0_init/migration.sql

echo "==> 2/4 Apply the documented runbook: mark the squashed baseline as already-applied"
# Records 0_init as applied WITHOUT running its SQL again.
npx prisma migrate resolve --applied 0_init

echo "==> 3/4 Deploy the remaining pending migrations onto the existing database"
# Every post-baseline schema/data migration runs exactly once here.
npx prisma migrate deploy

echo "==> 4/4 Assert no schema drift between the migrated DB and schema.prisma"
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code

echo "✅ Existing-DB baseline-reset runbook verified end-to-end (incl. post-0_init migrations)."
