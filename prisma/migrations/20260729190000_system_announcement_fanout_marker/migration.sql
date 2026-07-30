ALTER TABLE "SystemAnnouncement"
  ADD COLUMN "fanoutCompletedAt" TIMESTAMP(3),
  ADD COLUMN "recipientCount" INTEGER;

ALTER TABLE "SystemAnnouncement"
  ADD CONSTRAINT "SystemAnnouncement_recipientCount_check"
  CHECK ("recipientCount" IS NULL OR "recipientCount" >= 0);
