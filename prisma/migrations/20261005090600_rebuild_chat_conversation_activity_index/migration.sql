-- A single concurrent DDL statement permits chat writes throughout the rebuild.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatConversation_lastMessageAt_id_idx"
ON "ChatConversation" ("lastMessageAt" DESC NULLS LAST, id DESC);
