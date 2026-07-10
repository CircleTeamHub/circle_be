CREATE TYPE "NotificationPushOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "NotificationPushOutbox" (
    "id" TEXT NOT NULL,
    "notificationID" TEXT NOT NULL,
    "status" "NotificationPushOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationPushOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPushOutbox_notificationID_key" ON "NotificationPushOutbox"("notificationID");
CREATE INDEX "NotificationPushOutbox_status_nextAttemptAt_idx" ON "NotificationPushOutbox"("status", "nextAttemptAt");
ALTER TABLE "NotificationPushOutbox" ADD CONSTRAINT "NotificationPushOutbox_notificationID_fkey" FOREIGN KEY ("notificationID") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;
