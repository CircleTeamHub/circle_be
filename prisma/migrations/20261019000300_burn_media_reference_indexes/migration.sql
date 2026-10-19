CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_media_key_idx" ON "ChatMessage" ((content->>'key')) WHERE "deleted" = false AND (content->>'key') IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_media_thumbKey_idx" ON "ChatMessage" ((content->>'thumbKey')) WHERE "deleted" = false AND (content->>'thumbKey') IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_media_coverKey_idx" ON "ChatMessage" ((content->>'coverKey')) WHERE "deleted" = false AND (content->>'coverKey') IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatBurnArchive_media_key_idx" ON "ChatBurnArchive" ((content->>'key')) WHERE (content->>'key') IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatBurnArchive_media_thumbKey_idx" ON "ChatBurnArchive" ((content->>'thumbKey')) WHERE (content->>'thumbKey') IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatBurnArchive_media_coverKey_idx" ON "ChatBurnArchive" ((content->>'coverKey')) WHERE (content->>'coverKey') IS NOT NULL;
