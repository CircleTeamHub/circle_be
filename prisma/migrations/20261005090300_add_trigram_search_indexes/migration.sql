-- The admin console deliberately supports substring search. Plain B-tree
-- indexes cannot accelerate a leading wildcard (`%keyword%`); pg_trgm keeps
-- those bounded searches from degrading into repeated full-table scans.
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_accountId_trgm_idx"
ON "User" USING gin ("accountId" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_nickname_trgm_idx"
ON "User" USING gin ("nickname" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_inviteCode_trgm_idx"
ON "User" USING gin ("inviteCode" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Circle_id_trgm_idx"
ON "Circle" USING gin (id gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Circle_name_trgm_idx"
ON "Circle" USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Circle_groupID_trgm_idx"
ON "Circle" USING gin ("groupID" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "FancyNumber_value_trgm_idx"
ON "FancyNumber" USING gin (value gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "SensitiveWord_word_trgm_idx"
ON "SensitiveWord" USING gin (word gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CirclePost_content_trgm_idx"
ON "CirclePost" USING gin (content gin_trgm_ops)
WHERE status <> 'DELETED';

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CampaignInvite_code_trgm_idx"
ON "CampaignInvite" USING gin (code gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CampaignInvite_name_trgm_idx"
ON "CampaignInvite" USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAdvertisement_title_trgm_idx"
ON "AdminAdvertisement" USING gin (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatConversation_id_trgm_idx"
ON "ChatConversation" USING gin (id gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatConversation_name_trgm_idx"
ON "ChatConversation" USING gin (name gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatConversation_circleID_trgm_idx"
ON "ChatConversation" USING gin ("circleID" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_active_userID_trgm_idx"
ON "ChatMember" USING gin ("userID" gin_trgm_ops)
WHERE "leftAt" IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_active_alias_trgm_idx"
ON "ChatMember" USING gin (alias gin_trgm_ops)
WHERE "leftAt" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "AdminAuditLog_action_trgm_idx"
ON "AdminAuditLog" USING gin (action gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Note_active_title_trgm_idx"
ON "Note" USING gin (title gin_trgm_ops)
WHERE status <> 'DELETED';
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Note_active_content_trgm_idx"
ON "Note" USING gin (content gin_trgm_ops)
WHERE status <> 'DELETED';
