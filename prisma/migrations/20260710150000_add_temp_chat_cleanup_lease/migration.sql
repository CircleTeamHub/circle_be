ALTER TABLE "TempChat"
ADD COLUMN "cleanupLockedAt" TIMESTAMP(3),
ADD COLUMN "cleanupGroupDismissedAt" TIMESTAMP(3),
ADD COLUMN "cleanupCompletedAt" TIMESTAMP(3);

ALTER TABLE "TempChatGuest"
ADD COLUMN "provisioningFailedAt" TIMESTAMP(3);
