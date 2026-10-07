-- Admin substring search deliberately includes all statuses by default.
-- Build the full replacement before removing the existing partial index.
-- A cancelled concurrent build can leave an invalid index with this name.
-- Fail on every name conflict so deploy cannot skip that index and drop the
-- working partial index. See database-review-release-todo.md for recovery.
CREATE INDEX CONCURRENTLY "CirclePost_content_admin_trgm_idx"
ON "CirclePost" USING gin (content gin_trgm_ops);
