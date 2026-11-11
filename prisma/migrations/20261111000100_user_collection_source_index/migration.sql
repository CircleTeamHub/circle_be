-- 保留期清理跳过被收藏着的消息:NOT EXISTS (UserCollection WHERE sourceID = 消息 id)。
-- UserCollection 只有 (userID, type, createdAt) 索引,按 sourceID 反查是全表扫,
-- 每批 500 条消息都要查一次。部分索引只收有来源的行(消息/笔记收藏)。
--
-- CONCURRENTLY 的约束同 20261111000000:单条语句、无函数体,部署后查 indisvalid。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserCollection_source_message_idx"
ON "UserCollection" ("sourceID")
WHERE "sourceID" IS NOT NULL;
