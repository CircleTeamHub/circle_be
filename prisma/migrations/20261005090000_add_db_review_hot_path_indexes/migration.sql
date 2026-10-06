-- Hot-path indexes identified by the database review.
--
-- These statements are intentionally CONCURRENTLY: CircleMember,
-- ChatMessage, Notification, and ChatMember are write-heavy tables. Keep this
-- migration free of functions and DO blocks so Prisma can execute each
-- statement outside a transaction. Check pg_index.indisvalid after deploy;
-- an interrupted concurrent build must be dropped manually before retrying.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CircleMember_updatedAt_circleID_idx"
ON "CircleMember" ("updatedAt", "circleID");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CircleMember_circleID_status_userID_idx"
ON "CircleMember" ("circleID", "status", "userID");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatConversation_burning_id_idx"
ON "ChatConversation" ("id")
WHERE "burnDurationSec" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_live_conversation_createdAt_idx"
ON "ChatMessage" ("conversationID", "createdAt")
WHERE "deleted" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_active_recipient_created_idx"
ON "Notification" ("toUserID", "createdAt" DESC, "id" DESC)
WHERE "deleted" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_unread_recipient_type_idx"
ON "Notification" ("toUserID", "type")
WHERE "deleted" = false AND "read" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "DevicePushToken_active_user_provider_updatedAt_idx"
ON "DevicePushToken" ("userID", "provider", "updatedAt" DESC)
WHERE "disabledAt" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_visible_user_pinned_idx"
ON "ChatMember" ("userID", "pinned" DESC)
WHERE "leftAt" IS NULL AND "hiddenAt" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshToken_expiredAt_idx"
ON "RefreshToken" ("expiredAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "RefreshToken_revokedAt_idx"
ON "RefreshToken" ("revokedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "DevicePushToken_updatedAt_idx"
ON "DevicePushToken" ("updatedAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "DevicePushToken_disabledAt_idx"
ON "DevicePushToken" ("disabledAt");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CirclePost_createdAt_idx"
ON "CirclePost" ("createdAt");
