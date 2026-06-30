ALTER TABLE "CirclePost"
ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

-- Note: no DB-level column DEFAULT is set. The application always writes
-- expiresAt explicitly on create, and the auto-end sweep / visibility filter
-- both treat a NULL expiresAt as "createdAt + 24h", so a row that somehow lands
-- with NULL (e.g. created in the migration->deploy gap) still expires correctly
-- without a default. A default expression here would also drift against
-- schema.prisma in the migrate-diff CI gate.

-- Backfill expiry for existing posts.
-- New rule: a post lives 24h from creation. But applying that retroactively
-- would instantly expire every post older than 24h (the visibility filter
-- hides expired posts), making existing content vanish the moment this
-- deploys. To avoid that regression, give every existing post at least a 24h
-- grace window from deploy time: the later of (createdAt + 24h) and (now + 24h).
UPDATE "CirclePost"
SET "expiresAt" = GREATEST(
  "createdAt" + INTERVAL '24 hours',
  NOW() + INTERVAL '24 hours'
)
WHERE "expiresAt" IS NULL;

CREATE INDEX IF NOT EXISTS "CirclePost_status_expiresAt_idx" ON "CirclePost"("status", "expiresAt");
