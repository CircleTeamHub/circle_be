-- ChatConversation.lastMessageAt is nullable and the conversation list sorts
-- null activity last. Rebuild the raw index with the same null ordering so a
-- direct activity-ordered query can use the index without an extra sort.
-- This corrective migration is intentionally transactional: it runs during a
-- deploy immediately after the original index was built, so a short metadata
-- lock is preferable to leaving a failed migration behind.
DROP INDEX IF EXISTS "ChatConversation_lastMessageAt_id_idx";

CREATE INDEX IF NOT EXISTS "ChatConversation_lastMessageAt_id_idx"
ON "ChatConversation" ("lastMessageAt" DESC NULLS LAST, id DESC);
