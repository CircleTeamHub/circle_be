-- Keep this statement outside an implicit transaction: PostgreSQL cannot build a
-- concurrent index inside a transaction block.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_conversationID_deletedAt_idx"
ON "ChatMessage"("conversationID", "deletedAt");
