-- The read hot path only needs pending ephemeral messages, not all history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_pending_read_burn_idx"
ON "ChatMessage" ("conversationID", "height")
WHERE "deleted" = false AND "revokedAt" IS NULL
  AND "burnDurationSec" > 0 AND "burnExpiresAt" IS NULL;
