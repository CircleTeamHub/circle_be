CREATE TYPE "SupportRechargeRequestKind" AS ENUM ('GENERAL', 'AVATAR_FRAME', 'COIN', 'MEMBERSHIP');
CREATE TYPE "SupportRechargeOrderStatus" AS ENUM ('AWAITING_PROOF', 'WAITING_REVIEW', 'PROCESSING', 'APPROVED', 'REJECTED');
CREATE TYPE "SupportRechargeJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "SupportRechargeAutomationMode" AS ENUM ('BOT', 'HUMAN');
CREATE TYPE "SupportRechargeFulfillmentType" AS ENUM ('COIN', 'MEMBERSHIP', 'AVATAR_FRAME');

CREATE TABLE "SupportRechargePaymentCode" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "validFrom" TIMESTAMP(3) NOT NULL,
    "validUntil" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportRechargePaymentCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportRechargeConversationState" (
    "conversationID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "agentUserID" TEXT NOT NULL,
    "mode" "SupportRechargeAutomationMode" NOT NULL DEFAULT 'BOT',
    "lastWelcomeAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportRechargeConversationState_pkey" PRIMARY KEY ("conversationID")
);

CREATE TABLE "SupportRechargeOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "agentUserID" TEXT NOT NULL,
    "sourceMessageID" TEXT NOT NULL,
    "requestKind" "SupportRechargeRequestKind" NOT NULL,
    "status" "SupportRechargeOrderStatus" NOT NULL DEFAULT 'AWAITING_PROOF',
    "evidenceMessageID" TEXT,
    "evidenceObjectKey" TEXT,
    "submittedAt" TIMESTAMP(3),
    "fulfillmentType" "SupportRechargeFulfillmentType",
    "fulfillmentPayload" JSONB,
    "paymentTransactionID" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportRechargeOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportRechargeJob" (
    "id" TEXT NOT NULL,
    "sourceMessageID" TEXT NOT NULL,
    "status" "SupportRechargeJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SupportRechargeJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SupportRechargePaymentCode_objectKey_key" ON "SupportRechargePaymentCode"("objectKey");
CREATE INDEX "SupportRechargePaymentCode_enabled_validFrom_validUntil_idx" ON "SupportRechargePaymentCode"("enabled", "validFrom", "validUntil");
CREATE INDEX "SupportRechargeConversationState_userID_updatedAt_idx" ON "SupportRechargeConversationState"("userID", "updatedAt");
CREATE INDEX "SupportRechargeConversationState_agentUserID_updatedAt_idx" ON "SupportRechargeConversationState"("agentUserID", "updatedAt");
CREATE UNIQUE INDEX "SupportRechargeOrder_orderNo_key" ON "SupportRechargeOrder"("orderNo");
CREATE UNIQUE INDEX "SupportRechargeOrder_sourceMessageID_key" ON "SupportRechargeOrder"("sourceMessageID");
CREATE UNIQUE INDEX "SupportRechargeOrder_evidenceMessageID_key" ON "SupportRechargeOrder"("evidenceMessageID");
CREATE UNIQUE INDEX "SupportRechargeOrder_paymentTransactionID_key" ON "SupportRechargeOrder"("paymentTransactionID");
CREATE INDEX "SupportRechargeOrder_status_createdAt_idx" ON "SupportRechargeOrder"("status", "createdAt");
CREATE INDEX "SupportRechargeOrder_userID_createdAt_idx" ON "SupportRechargeOrder"("userID", "createdAt");
CREATE INDEX "SupportRechargeOrder_conversationID_status_createdAt_idx" ON "SupportRechargeOrder"("conversationID", "status", "createdAt");
CREATE UNIQUE INDEX "SupportRechargeJob_sourceMessageID_key" ON "SupportRechargeJob"("sourceMessageID");
CREATE INDEX "SupportRechargeJob_status_nextAttemptAt_createdAt_idx" ON "SupportRechargeJob"("status", "nextAttemptAt", "createdAt");
