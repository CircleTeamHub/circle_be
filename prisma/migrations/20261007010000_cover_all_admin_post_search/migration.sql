-- Admin substring search deliberately includes all statuses by default.
-- Build the full replacement before removing the existing partial index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CirclePost_content_admin_trgm_idx"
ON "CirclePost" USING gin (content gin_trgm_ops);
