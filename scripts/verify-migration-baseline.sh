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
# We reproduce that state with `prisma db push` (live schema, no migration
# history) and then run the documented runbook, asserting it ends drift-free.
#
# Usage: DATABASE_URL=postgres://... bash scripts/verify-migration-baseline.sh
# DATABASE_URL MUST point at a disposable database — this script mutates it.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point at a disposable Postgres database}"

echo "==> 1/4 Simulate an existing db-push-built database (live schema, no migration history)"
npx prisma db push --accept-data-loss

echo "==> 2/4 Apply the documented runbook: mark the baseline and schema migrations as already-applied"
# Records the baseline and all migrations whose schema is already represented
# by `prisma db push` as applied WITHOUT running their SQL. The data migration
# is intentionally excluded so it still runs in the next step.
npx prisma migrate resolve --applied 0_init

DATA_MIGRATION="20260623000000_remove_account_id_prefix"
while IFS= read -r migration_path; do
  migration="$(basename "$migration_path")"
  if [[ "$migration" == "0_init" || "$migration" == "$DATA_MIGRATION" ]]; then
    continue
  fi
  npx prisma migrate resolve --applied "$migration"
done < <(find prisma/migrations -mindepth 1 -maxdepth 1 -type d | sort)

echo "==> 3/4 Deploy the remaining pending data migration onto the existing database"
# Only the data migration runs here. All schema migrations are already covered
# by the live schema created in step 1 and were marked applied above.
npx prisma migrate deploy

echo "==> 4/4 Assert no schema drift between the migrated DB and schema.prisma"
npx prisma migrate diff \
  --from-config-datasource \
  --to-schema prisma/schema.prisma \
  --exit-code

echo "✅ Existing-DB baseline-reset runbook verified end-to-end (incl. post-0_init migrations)."
