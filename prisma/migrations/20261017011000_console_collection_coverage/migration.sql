CREATE TABLE "ConsoleCollectionState" (id TEXT PRIMARY KEY DEFAULT 'global', "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "ConsoleCollectionState" (id,"startedAt") SELECT 'global',COALESCE((SELECT started_at FROM _prisma_migrations WHERE migration_name='20261017010000_operations_console' AND finished_at IS NOT NULL ORDER BY started_at LIMIT 1),CURRENT_TIMESTAMP);
