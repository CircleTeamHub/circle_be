-- AlterTable: track which signups the post author has already reviewed, so the
-- signup-management tab can show per-post unread counts.
ALTER TABLE "CirclePostSignup" ADD COLUMN     "seenByAuthor" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seenAt" TIMESTAMP(3);

-- Backfill author-read signup state from the retired activity stream while the
-- CircleActivity table is still available. Without this, every historical
-- signup would become unread again after deployment.
UPDATE "CirclePostSignup" signup
SET "seenByAuthor" = true,
    "seenAt" = activity."readAt"
FROM "CircleActivity" activity
WHERE activity."type" = 'POST_SIGNUP_RECEIVED'
  AND activity."readAt" IS NOT NULL
  AND activity."postID" = signup."postID"
  AND activity."actorID" = signup."userID";

-- CreateIndex
CREATE INDEX "CirclePostSignup_postID_seenByAuthor_idx" ON "CirclePostSignup"("postID", "seenByAuthor");
