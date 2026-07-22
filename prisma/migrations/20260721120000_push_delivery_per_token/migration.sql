-- #88: per-(notification, token) push delivery tracking + payload snapshot.
CREATE TYPE "NotificationPushDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'CONFIRMED', 'FAILED', 'TERMINAL');

ALTER TABLE "NotificationPushOutbox" ADD COLUMN "payload" JSONB;

CREATE TABLE "NotificationPushDelivery" (
    "id" TEXT NOT NULL,
    "outboxID" TEXT NOT NULL,
    "notificationID" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "ticketID" TEXT,
    "status" "NotificationPushDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "receiptCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NotificationPushDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotificationPushDelivery_notificationID_token_key" ON "NotificationPushDelivery"("notificationID", "token");
CREATE INDEX "NotificationPushDelivery_status_sentAt_idx" ON "NotificationPushDelivery"("status", "sentAt");

ALTER TABLE "NotificationPushDelivery" ADD CONSTRAINT "NotificationPushDelivery_outboxID_fkey" FOREIGN KEY ("outboxID") REFERENCES "NotificationPushOutbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;
