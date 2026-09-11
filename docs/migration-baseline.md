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

## CONCURRENTLY 索引：失败残骸要人工清

热表上的索引用 `CREATE INDEX CONCURRENTLY` 建，避免构建期间停写（例：
`20260906010000_add_chat_member_fanout_index` 之于 `ChatMember`）。

它的失败模式是留下一个 `indisvalid = false` 的同名索引：占着名字、吃着写入开销，
却永远不会被规划器选中。而迁移文件里写的是 `IF NOT EXISTS`，重跑会直接跳过并把
迁移标成已应用 —— 索引从此不存在，且没有任何信号。

**不要在迁移文件里加 `DROP INDEX CONCURRENTLY IF EXISTS` 来自愈。** 实测会失败：

```
ERROR: DROP INDEX CONCURRENTLY cannot run inside a transaction block  (SQLSTATE 25001)
```

同一个文件里纯 `CREATE INDEX CONCURRENTLY` 是可以的（见
`20260729131000_admin_dashboard_indexes`，一个文件里 10 条都正常应用），
但只要混进 `DROP ... CONCURRENTLY` 整个迁移就红。

所以处置放在部署自检里，每次 `migrate deploy` 之后跑一遍：

```sql
SELECT c.relname
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid;
```

有输出就说明上一次 CONCURRENTLY 建索引被中断了。人工处置（两句都在事务外单独执行）：

```sql
DROP INDEX CONCURRENTLY "<名字>";
-- 然后把该迁移对应的 CREATE INDEX CONCURRENTLY 语句手动补跑一次
```
