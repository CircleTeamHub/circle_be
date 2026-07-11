-- Many-to-many: a circle post can belong to multiple circles.
-- Additive + non-destructive: CirclePost.circleID stays as the PRIMARY circle
-- (= circleIds[0]) so existing queries/counts keep working. This junction holds
-- ALL circles a post is shared to (including the primary). Feed visibility and
-- per-circle filtering read the junction.

CREATE TABLE "CirclePostCircle" (
    "id" TEXT NOT NULL,
    "postID" TEXT NOT NULL,
    "circleID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CirclePostCircle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CirclePostCircle_postID_circleID_key" ON "CirclePostCircle"("postID", "circleID");
CREATE INDEX "CirclePostCircle_circleID_postID_idx" ON "CirclePostCircle"("circleID", "postID");

-- Backfill: every existing post's primary circle becomes its (only) link.
-- gen_random_uuid() is core in PostgreSQL 13+; pgcrypto guard is defensive.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
INSERT INTO "CirclePostCircle" ("id", "postID", "circleID", "createdAt")
SELECT gen_random_uuid(), "id", "circleID", "createdAt"
FROM "CirclePost";

ALTER TABLE "CirclePostCircle"
  ADD CONSTRAINT "CirclePostCircle_postID_fkey"
  FOREIGN KEY ("postID") REFERENCES "CirclePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CirclePostCircle"
  ADD CONSTRAINT "CirclePostCircle_circleID_fkey"
  FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;
