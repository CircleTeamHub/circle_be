-- Prisma DateTime uses UTC in timestamp-without-time-zone columns. PostgreSQL
-- session TimeZone may differ; trigger timestamps must not depend on that setting.
UPDATE "ConsoleEvent" SET "createdAt"="createdAt" AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC' WHERE source='SERVER';
ALTER TABLE "ConsoleEvent" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE "AppInstallation" ALTER COLUMN "lastSeenAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE "ConsoleApiKey" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE "ConsoleRelease" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE "ConsoleReleasePlan" ALTER COLUMN "createdAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE "ConsolePushSettings" ALTER COLUMN "updatedAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
ALTER TABLE "ConsoleCollectionState" ALTER COLUMN "startedAt" SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC');
UPDATE "ConsoleCollectionState" SET "startedAt"=(SELECT started_at AT TIME ZONE 'UTC' FROM _prisma_migrations WHERE migration_name='20261017010000_operations_console' AND finished_at IS NOT NULL ORDER BY started_at LIMIT 1) WHERE id='global';
