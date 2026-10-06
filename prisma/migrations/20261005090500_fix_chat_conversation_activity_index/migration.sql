-- Prisma sends each migration as one script. Keep concurrent index DDL in
-- separate migration files so PostgreSQL does not open an implicit transaction.
-- The following migration immediately rebuilds the activity index with NULLS LAST.
DROP INDEX CONCURRENTLY IF EXISTS "ChatConversation_lastMessageAt_id_idx";
