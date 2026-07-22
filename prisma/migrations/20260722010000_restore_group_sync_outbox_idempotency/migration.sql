-- The pre-squash history enforced one retryable job per operation/group/user.
-- Settle duplicate open jobs before restoring that invariant on upgraded DBs.
WITH ranked_open_jobs AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "operation", "groupID", "userID"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS duplicate_rank
  FROM "GroupSyncOutbox"
  WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED')
)
UPDATE "GroupSyncOutbox" AS job
SET
  "status" = 'COMPLETED',
  "processedAt" = COALESCE(job."processedAt", CURRENT_TIMESTAMP),
  "lockedAt" = NULL,
  "lastError" = COALESCE(job."lastError", 'Superseded duplicate open job'),
  "updatedAt" = CURRENT_TIMESTAMP
FROM ranked_open_jobs AS ranked
WHERE job."id" = ranked."id"
  AND ranked.duplicate_rank > 1;

CREATE UNIQUE INDEX "GroupSyncOutbox_open_active_key"
ON "GroupSyncOutbox"("operation", "groupID", "userID")
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
