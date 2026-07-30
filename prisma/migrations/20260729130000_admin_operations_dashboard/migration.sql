BEGIN;

CREATE TYPE "CircleAdminState" AS ENUM (
  'ACTIVE',
  'DISABLING',
  'DISABLED',
  'RESTORING',
  'SYNC_FAILED'
);

CREATE TYPE "AdminGroupOperationType" AS ENUM ('MUTE', 'UNMUTE', 'DISMISS');
CREATE TYPE "AdminGroupOperationStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED'
);

ALTER TABLE "Circle"
ADD COLUMN "adminState" "CircleAdminState" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "adminDisabledAt" TIMESTAMP(3),
ADD COLUMN "adminDisabledBy" TEXT,
ADD COLUMN "adminDisableReason" TEXT;

CREATE TABLE "AdminGroupOperation" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "groupID" TEXT NOT NULL,
  "circleID" TEXT,
  "type" "AdminGroupOperationType" NOT NULL,
  "status" "AdminGroupOperationStatus" NOT NULL DEFAULT 'PENDING',
  "requestedByID" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdminGroupOperation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdminGroupOperation_idempotencyKey_key"
ON "AdminGroupOperation" ("idempotencyKey");

CREATE UNIQUE INDEX "AdminGroupOperation_active_group_key"
ON "AdminGroupOperation" ("groupID")
WHERE "status" IN ('PENDING', 'PROCESSING');

CREATE INDEX "AdminGroupOperation_status_nextAttemptAt_idx"
ON "AdminGroupOperation" ("status", "nextAttemptAt");
CREATE INDEX "AdminGroupOperation_groupID_createdAt_idx"
ON "AdminGroupOperation" ("groupID", "createdAt");
CREATE INDEX "AdminGroupOperation_circleID_createdAt_idx"
ON "AdminGroupOperation" ("circleID", "createdAt");

COMMIT;
