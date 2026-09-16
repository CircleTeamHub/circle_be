-- 增量同步（GET /chat/conversations/:id/sync）按 (conversationID, revision) 区间扫。
--
-- ChatMessage 是全系统最热的表：普通 CREATE INDEX 在构建期间挡住所有发消息、撤回、
-- 编辑、回应与焚毁清扫。CONCURRENTLY 不停写（docs/migration-baseline.md 的约定，
-- 先例 20260906010000_add_chat_member_fanout_index）；本文件不含美元符号引用，
-- 语句单独自动提交，CONCURRENTLY 才允许执行。回填之后再建，回填期间的更新不用维护它。
--
-- 失败会留下 indisvalid = false 的同名残骸，IF NOT EXISTS 重跑会直接跳过：
-- 按 migration-baseline.md 的部署自检查无效索引并手工清理后重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_conversationID_revision_idx"
ON "ChatMessage"("conversationID", "revision");
