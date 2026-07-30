BEGIN;

CREATE TABLE "SystemAnnouncement" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "operatorID" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SystemAnnouncement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SystemAnnouncement_idempotencyKey_key"
ON "SystemAnnouncement" ("idempotencyKey");

CREATE INDEX "SystemAnnouncement_createdAt_idx"
ON "SystemAnnouncement" ("createdAt");

ALTER TABLE "Notification"
ADD COLUMN "systemAnnouncementID" TEXT;

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_systemAnnouncementID_fkey"
FOREIGN KEY ("systemAnnouncementID") REFERENCES "SystemAnnouncement" ("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Notification_announcement_recipient_key"
ON "Notification" ("systemAnnouncementID", "toUserID");

COMMIT;
