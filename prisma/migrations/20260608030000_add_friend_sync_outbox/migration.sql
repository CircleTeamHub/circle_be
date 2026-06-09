-- CreateEnum
CREATE TYPE "FriendSyncOperation" AS ENUM ('IMPORT_FRIEND', 'DELETE_FRIEND', 'ADD_BLACKLIST', 'REMOVE_BLACKLIST');

-- CreateEnum
CREATE TYPE "FriendSyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "FriendSyncOutbox" (
    "id" TEXT NOT NULL,
    "operation" "FriendSyncOperation" NOT NULL,
    "status" "FriendSyncStatus" NOT NULL DEFAULT 'PENDING',
    "userID" TEXT NOT NULL,
    "targetUserID" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendSyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FriendSyncOutbox_status_nextAttemptAt_idx" ON "FriendSyncOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FriendSyncOutbox_userID_targetUserID_status_idx" ON "FriendSyncOutbox"("userID", "targetUserID", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FriendSyncOutbox_open_active_key"
ON "FriendSyncOutbox"("operation", "userID", "targetUserID")
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');
