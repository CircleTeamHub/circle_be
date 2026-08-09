-- G-05 发号：会话行计数器替代 pg_advisory_xact_lock + MAX(height) 聚合。
ALTER TABLE "ChatConversation" ADD COLUMN "nextHeight" INTEGER NOT NULL DEFAULT 0;

-- 回填：计数器语义是「最后已分配的 height」，必须等于各会话现有 MAX(height)；
-- 留 0 的话下一条消息取号 1，撞 (conversationID, height) 唯一约束。
UPDATE "ChatConversation" c
SET "nextHeight" = COALESCE(
  (SELECT MAX(m."height") FROM "ChatMessage" m WHERE m."conversationID" = c."id"),
  0
);
