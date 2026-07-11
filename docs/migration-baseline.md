# Migration baseline reset (2026-06-23)

## Why

The migration chain never applied cleanly to a **fresh** database. The
lexically-first migration `20260408170000_friend_activities` referenced the
`FriendState` enum and the `Friend` table, both of which were only created by
the _next_ migration (`20260409000751_...`). Existing dev/prod databases only
worked because they were built incrementally (originally via `db push`), so the
objects already existed.

This blocked: new dev machines, CI provisioning, and disaster recovery.

## What changed

- The 38 tangled historical migrations were moved to
  [`prisma/_archived_migrations_pre_0_init/`](../prisma/_archived_migrations_pre_0_init)
  (kept for reference; not on Prisma's active path).
- A single squashed baseline `prisma/migrations/0_init/` was generated from the
  current `schema.prisma` (`prisma migrate diff --from-empty --to-schema ...`).
  It reproduces the exact current schema (62 tables, 45 enums) in dependency
  order, and was verified drift-free against `schema.prisma`.
- Post-baseline schema and data migrations remain after `0_init` and must run
  normally on existing databases after the one-time baseline reconciliation.

Net active chain: `0_init` followed by the chronological post-baseline
migrations in `prisma/migrations/`.

## Rollout

### Fresh database / CI / new environment

Nothing special — the normal command applies the baseline then every later
migration:

```bash
npx prisma migrate deploy
```

Verified: applies cleanly from empty, then `migrate diff` reports no drift.

### Existing database (dev / staging / prod) — ONE-TIME reconciliation

The baseline must be marked as already-applied so Prisma does not try to
recreate existing tables. **Run once per existing environment, in order:**

```bash
# 1. Mark the squashed schema as already applied (does NOT run the SQL).
npx prisma migrate resolve --applied 0_init

# 2. Apply every remaining post-baseline migration.
npx prisma migrate deploy
```

Verified against a simulated existing baseline DB: the verification script
executes `0_init` SQL without recording history, `resolve --applied 0_init`
records the baseline without re-running it, and `deploy` applies every later
migration exactly once. Prisma tolerates the 38 archived
migrations still present in `_prisma_migrations` (they are reported as
"not found locally" but do not block `deploy`).

> ⚠️ Before running on prod, take a snapshot and ideally rehearse on a restored
> copy. The fresh-DB path is fully validated; the existing-DB path was validated
> against a simulated state, not your actual prod `_prisma_migrations` table.
