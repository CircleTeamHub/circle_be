-- 焚毁后的消息只变成墓碑(deleted = true,正文清空),从不物理删除。读路径全都带着
-- deleted = false,却只能沿 (conversationID, height) 唯一索引逐条跨过墓碑:
--   - 历史页(getHistory)、会话列表的末条消息与未读数(chat-conversation-summary.query.ts);
--   - 「图片 / 视频 / 文件」页签(getHistory 的 types 过滤):沿 (conversationID, height)
--     倒着扫、逐行回表判断 type,匹配少的会话要把整段历史扫完。
-- 两条部分索引都只收活消息,焚毁后行就离开索引:
--   1. (conversationID, height):上面三处都按它倒序 / 按水位往上取;
--   2. (conversationID, type, height):类型页签按 type 等值直接定位,单类型时顺着 height
--      倒序取一页即停;多类型(type IN (...))只读这几类的行再排序。
-- type 集合不写进谓词:getHistory 的 types 是客户端给的白名单
-- (HISTORY_FILTER_MESSAGE_TYPES),哪一类都可能被单独筛。
-- 谓词必须和查询一样是 deleted = false:Prisma 发的是 "deleted" = $n,规划时按实参折成
-- 常量,能证明;原生 SQL 里写字面量。
--
-- CONCURRENTLY:ChatMessage 是全系统最热的表。文件里不能有函数体或 DO 块,Prisma 才会
-- 把每条语句放在事务外执行。部署后查 pg_index.indisvalid,中断的并发建索引会留下 invalid
-- 索引,IF NOT EXISTS 会把它当成已存在 —— 遇到要先手动 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_live_conversation_height_idx"
ON "ChatMessage" ("conversationID", "height")
WHERE "deleted" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_live_conversation_type_height_idx"
ON "ChatMessage" ("conversationID", "type", "height")
WHERE "deleted" = false;
