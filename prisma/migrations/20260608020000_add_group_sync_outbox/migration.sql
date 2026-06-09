-- CreateEnum
CREATE TYPE "GroupSyncOperation" AS ENUM ('ADD_MEMBER', 'REMOVE_MEMBER');

-- CreateEnum
CREATE TYPE "GroupSyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "GroupSyncOutbox" (
    "id" TEXT NOT NULL,
    "operation" "GroupSyncOperation" NOT NULL,
    "status" "GroupSyncStatus" NOT NULL DEFAULT 'PENDING',
    "groupID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupSyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupSyncOutbox_status_nextAttemptAt_idx" ON "GroupSyncOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "GroupSyncOutbox_groupID_userID_status_idx" ON "GroupSyncOutbox"("groupID", "userID", "status");

-- CreateIndex
CREATE UNIQUE INDEX "GroupSyncOutbox_open_active_key"
ON "GroupSyncOutbox"("operation", "groupID", "userID")
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
