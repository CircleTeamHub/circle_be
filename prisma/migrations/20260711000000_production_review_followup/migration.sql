-- Keep the physical legacy column through a complete rolling-deploy cycle.
ALTER TABLE "Circle"
  ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "UserProfileSyncOutbox"
  ADD COLUMN IF NOT EXISTS "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;

ALTER TABLE "FriendChatReplayOutbox"
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;

ALTER TABLE "NotificationPushOutbox"
  ADD COLUMN IF NOT EXISTS "leaseToken" TEXT;

ALTER TYPE "NotificationPushOutboxStatus"
  ADD VALUE IF NOT EXISTS 'TERMINAL';
