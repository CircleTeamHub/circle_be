-- The full index also serves non-deleted post searches. Avoid maintaining
-- duplicate GIN indexes after the replacement has finished building.
DROP INDEX CONCURRENTLY IF EXISTS "CirclePost_content_trgm_idx";
