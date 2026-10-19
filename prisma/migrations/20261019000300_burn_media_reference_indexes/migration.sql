CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_media_key_idx" ON "ChatMessage" ((content->>'key')) WHERE "deleted" = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_media_thumbKey_idx" ON "ChatMessage" ((content->>'thumbKey')) WHERE "deleted" = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_media_coverKey_idx" ON "ChatMessage" ((content->>'coverKey')) WHERE "deleted" = false;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatBurnArchive_media_key_idx" ON "ChatBurnArchive" ((content->>'key'));
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatBurnArchive_media_thumbKey_idx" ON "ChatBurnArchive" ((content->>'thumbKey'));
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatBurnArchive_media_coverKey_idx" ON "ChatBurnArchive" ((content->>'coverKey'));
