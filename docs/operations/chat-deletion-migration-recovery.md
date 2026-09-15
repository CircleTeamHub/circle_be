# Chat deletion migration recovery (PR #233)

The released `20260913001000_add_chat_message_deleted_at` migration is restored byte-for-byte. It adds the column, timestamps existing deleted messages, and creates the index. The redundant, unmerged `20260913001100_index_chat_message_deleted_at` migration is removed. No concurrent-index retry is introduced by this PR.

## Normal rollout

Databases that applied the original migration need no repair. Fresh databases run that same original migration. It contains a full-table backfill and a regular index build: schedule first-time application in a maintenance window with enough capacity; do not rewrite this migration to optimize it.

## Only if the earlier PR revision was deployed

Do not reset the database or re-run the column ADD. Back up the database and migration records, pause migration runners, and inspect `_prisma_migrations` and the actual schema first. Preserve the prior release artifact for audit and recovery. Perform the following in the application's schema using an operator-owned connection.

1. Confirm `ChatMessage.deletedAt` exists as nullable `timestamp(3)`.
2. Repair missing deletion timestamps in bounded, independently committed batches. Repeat until the affected-row count is zero. The repair time is intentional: devices with earlier mutation cursors must receive these tombstones.

```sql
WITH batch AS (
  SELECT "id" FROM "ChatMessage"
  WHERE "deleted" = true AND "deletedAt" IS NULL
  ORDER BY "id" LIMIT 1000
  FOR UPDATE SKIP LOCKED
)
UPDATE "ChatMessage" AS m
SET "deletedAt" = CURRENT_TIMESTAMP
FROM batch WHERE m."id" = batch."id";
```

After writers are quiescent, separately confirm `COUNT(*) = 0` for the same predicate; a zero-sized SKIP LOCKED batch alone does not prove completion.

3. Inspect `pg_index.indisvalid` and `pg_get_indexdef` for `ChatMessage_conversationID_deletedAt_idx`. A valid index on `(conversationID, deletedAt)` is retained. If an interrupted concurrent build left it invalid, drop that specific invalid index with `DROP INDEX CONCURRENTLY` outside any transaction, then run the following as its own statement:

```sql
CREATE INDEX CONCURRENTLY "ChatMessage_conversationID_deletedAt_idx"
ON "ChatMessage"("conversationID", "deletedAt");
```

Do not use `IF NOT EXISTS`: a leftover invalid relation must fail loudly. Check validity and column order again after creation. If creation fails, inspect and remove only the invalid build artifact before retrying.

4. After data and index verification, reconcile migration history under DBA approval. The restored migration's LF SHA-256 is `808348ad0863431e5e6b8d4c44cc4f88c674689a3f79aefc4bd68e843b8ea05b`; the discarded column-only file's hash is `cd7846ebc527696b53a24ff2b6929ce7f7aff5fe574c3522172b3cd66ef670d8`. For a successfully applied column-only record, conditionally replace only that known old checksum with the restored checksum after recording the repair evidence. Stop on any other checksum or failed migration state; do not blindly mark it applied. If the discarded `20260913001100` record also exists, archive its record and logs, then reconcile that redundant record only after confirming its index is represented by the restored migration. Never delete the index to remove a history entry.
5. Run `prisma migrate status` and the normal deployment migration command. Verify an existing-deleted row has a timestamp and appears in a mutation poll from before repair. Resume writers and migration runners only after these checks.

The PostgreSQL regression in `test/chat-message-deleted-at-migration.e2e-spec.ts` uses a session-local temporary table, covers legacy deleted rows and valid index creation, and runs in the existing fresh-database CI job.
