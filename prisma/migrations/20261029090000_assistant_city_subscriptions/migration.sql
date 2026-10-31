CREATE TYPE "AssistantAlertEventType" AS ENUM ('INFO_PUBLISHED');

CREATE TYPE "AssistantAlertDeliveryStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'SENT',
    'FAILED',
    'SKIPPED'
);

CREATE TABLE "AssistantSubscription" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "assistantKey" TEXT NOT NULL DEFAULT 'windnote-assistant',
    "circleID" TEXT NOT NULL,
    "cities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "sourceTypes" TEXT[] NOT NULL DEFAULT ARRAY['PLAZA_POST']::TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssistantAlertDelivery" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "assistantKey" TEXT NOT NULL DEFAULT 'windnote-assistant',
    "subscriptionIDs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "eventType" "AssistantAlertEventType" NOT NULL DEFAULT 'INFO_PUBLISHED',
    "sourceID" TEXT NOT NULL,
    "sourceVersion" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "status" "AssistantAlertDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "conversationID" TEXT,
    "messageID" TEXT,
    "payloadSnapshot" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "lastError" VARCHAR(1000),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantAlertDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssistantSubscription_userID_assistantKey_circleID_key"
    ON "AssistantSubscription"("userID", "assistantKey", "circleID");
CREATE INDEX "AssistantSubscription_userID_enabled_idx"
    ON "AssistantSubscription"("userID", "enabled");
CREATE INDEX "AssistantSubscription_circleID_enabled_idx"
    ON "AssistantSubscription"("circleID", "enabled");

CREATE UNIQUE INDEX "AssistantAlertDelivery_dedupeKey_key"
    ON "AssistantAlertDelivery"("dedupeKey");
CREATE INDEX "AssistantAlertDelivery_status_nextAttemptAt_createdAt_idx"
    ON "AssistantAlertDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "AssistantAlertDelivery_userID_createdAt_idx"
    ON "AssistantAlertDelivery"("userID", "createdAt");
CREATE INDEX "AssistantAlertDelivery_sourceID_eventType_idx"
    ON "AssistantAlertDelivery"("sourceID", "eventType");

ALTER TABLE "AssistantSubscription"
    ADD CONSTRAINT "AssistantSubscription_userID_fkey"
    FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantSubscription"
    ADD CONSTRAINT "AssistantSubscription_circleID_fkey"
    FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantAlertDelivery"
    ADD CONSTRAINT "AssistantAlertDelivery_userID_fkey"
    FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
