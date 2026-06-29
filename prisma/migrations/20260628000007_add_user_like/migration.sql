-- Idempotent so the existing-DB baseline-reset runbook (db push → resolve 0_init
-- → migrate deploy) re-applies cleanly when these objects already exist.

-- AlterTable
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "receivedLikeCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE IF NOT EXISTS "UserLike" (
    "id" TEXT NOT NULL,
    "fromUserID" TEXT NOT NULL,
    "toUserID" TEXT NOT NULL,
    "likedOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserLike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserLike_toUserID_idx" ON "UserLike"("toUserID");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserLike_fromUserID_idx" ON "UserLike"("fromUserID");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "UserLike_fromUserID_toUserID_likedOn_key" ON "UserLike"("fromUserID", "toUserID", "likedOn");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserLike_fromUserID_fkey') THEN
    ALTER TABLE "UserLike" ADD CONSTRAINT "UserLike_fromUserID_fkey" FOREIGN KEY ("fromUserID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserLike_toUserID_fkey') THEN
    ALTER TABLE "UserLike" ADD CONSTRAINT "UserLike_toUserID_fkey" FOREIGN KEY ("toUserID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
