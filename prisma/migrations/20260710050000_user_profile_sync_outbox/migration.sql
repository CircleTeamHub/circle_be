CREATE TYPE "UserProfileSyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "UserProfileSyncOutbox" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "status" "UserProfileSyncStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UserProfileSyncOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserProfileSyncOutbox_userID_key" ON "UserProfileSyncOutbox"("userID");
CREATE INDEX "UserProfileSyncOutbox_status_nextAttemptAt_idx" ON "UserProfileSyncOutbox"("status", "nextAttemptAt");
ALTER TABLE "UserProfileSyncOutbox" ADD CONSTRAINT "UserProfileSyncOutbox_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
