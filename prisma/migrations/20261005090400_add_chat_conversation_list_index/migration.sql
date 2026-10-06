-- The chat list joins ChatMember to ChatConversation and orders the joined
-- conversations by last activity after pinned seats. Keep a deterministic
-- tie-breaker for equal timestamps.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatConversation_lastMessageAt_id_idx"
ON "ChatConversation" ("lastMessageAt" DESC, id DESC);
