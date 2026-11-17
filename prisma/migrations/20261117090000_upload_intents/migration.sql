-- New table only: existing application versions do not read or write upload intents,
-- so this migration is safe to deploy before the corresponding application release.
CREATE TYPE "UploadIntentStatus" AS ENUM ('PENDING', 'DELETING', 'CLAIMED', 'DELETED');

CREATE TYPE "UploadIntentPurpose" AS ENUM ('PROFILE_AVATAR', 'CIRCLE_AVATAR', 'PLAZA_POST', 'MOMENT', 'MOMENT_COMMENT');

CREATE TABLE "UploadIntent" (
    "id" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "purpose" "UploadIntentPurpose" NOT NULL,
    "folder" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "status" "UploadIntentStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "deleteLeaseUntil" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deleteAttempts" INTEGER NOT NULL DEFAULT 0,
    "lastDeleteError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UploadIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UploadIntent_objectKey_key" ON "UploadIntent"("objectKey");

CREATE INDEX "UploadIntent_status_expiresAt_idx" ON "UploadIntent"("status", "expiresAt");
