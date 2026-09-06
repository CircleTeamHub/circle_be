-- 每条 chat:msg / chat:edit 的收件人查询长这样：
--   WHERE "conversationID" = $1 AND "leftAt" IS NULL AND "clearedBeforeHeight" < $2
-- 在此之前 ChatMember 上唯一能用的是 (conversationID, userID) 唯一索引：只能取到
-- 会话前缀，leftAt 与 clearedBeforeHeight 两个条件都得逐行回表判。3000 人的圈子群
-- 里，这是每条消息两次全量回表 —— 广播路径一次，推送路径一次。
--
-- 把过滤列按 conversationID -> leftAt -> clearedBeforeHeight 的顺序排进索引，
-- 再把两条查询各自 select 的 userID / muted 挂在尾部当覆盖列，两边都能走
-- index-only scan，回表降到 0。leftAt IS NULL 与 clearedBeforeHeight < N 分别是
-- btree 的 NULL 条件和范围条件，都能作为索引条件下推。
--
-- 写入侧的代价是可控的：ChatMember 上最频繁的更新是 lastReadHeight /
-- lastDeliveredHeight / hiddenAt，三者都不在这个索引里，HOT update 仍然成立。
-- 索引里的 leftAt / clearedBeforeHeight / muted 都是低频变更。
CREATE INDEX "ChatMember_fanout_idx"
ON "ChatMember"("conversationID", "leftAt", "clearedBeforeHeight", "userID", "muted");
