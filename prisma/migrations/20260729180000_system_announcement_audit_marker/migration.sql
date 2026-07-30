ALTER TABLE "SystemAnnouncement"
ADD COLUMN IF NOT EXISTS "auditRecordedAt" TIMESTAMP(3);
