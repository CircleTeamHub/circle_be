-- Friend reports now go through admin review before affecting credit.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FriendReportStatus') THEN
    CREATE TYPE "FriendReportStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
  END IF;
END $$;

ALTER TABLE "FriendReport"
  ADD COLUMN IF NOT EXISTS "status" "FriendReportStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "reviewedByID" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "reviewNote" TEXT;

-- Existing reports already deducted credit under the old instant-deduct
-- behavior, so treat them as already approved rather than pending re-review.
UPDATE "FriendReport" SET "status" = 'APPROVED', "reviewedAt" = "createdAt"
WHERE "status" = 'PENDING' AND "reviewedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "FriendReport_status_createdAt_idx" ON "FriendReport"("status", "createdAt");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FriendReport_reviewedByID_fkey') THEN
    ALTER TABLE "FriendReport" ADD CONSTRAINT "FriendReport_reviewedByID_fkey" FOREIGN KEY ("reviewedByID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
