-- Friend reports now go through admin review before affecting credit.
CREATE TYPE "FriendReportStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

ALTER TABLE "FriendReport"
  ADD COLUMN "status" "FriendReportStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "reviewedByID" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewNote" TEXT;

-- Existing reports already deducted credit under the old instant-deduct
-- behavior, so treat them as already approved rather than pending re-review.
UPDATE "FriendReport" SET "status" = 'APPROVED', "reviewedAt" = "createdAt";

CREATE INDEX "FriendReport_status_createdAt_idx" ON "FriendReport"("status", "createdAt");

ALTER TABLE "FriendReport"
  ADD CONSTRAINT "FriendReport_reviewedByID_fkey"
  FOREIGN KEY ("reviewedByID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
