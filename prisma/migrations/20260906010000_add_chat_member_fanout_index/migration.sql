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
-- ChatMember 是收发消息与成员变更的热表；普通 CREATE INDEX 会在构建期间
-- 阻塞写入。CONCURRENTLY 避免发布窗口停写。
--
-- CONCURRENTLY 的失败模式是留下一个 indisvalid = false 的索引：它占着名字、
-- 吃着写入开销，却永远不会被规划器选中。只写 IF NOT EXISTS 的话重跑会撞上这个
-- 残骸、直接跳过并把迁移标成已应用 —— 索引从此不存在而没有任何信号，等到某天
-- 3000 人的群发消息变慢才发现。所以先无条件把同名索引删掉再重建：正常首次执行
-- 时这句是空操作，重跑时它清掉的正是上一次的失败残骸。DROP ... CONCURRENTLY
-- 同样不取 ACCESS EXCLUSIVE 锁，不会把停写又加回来。
DROP INDEX CONCURRENTLY IF EXISTS "ChatMember_fanout_idx";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMember_fanout_idx"
ON "ChatMember"("conversationID", "leftAt", "clearedBeforeHeight", "userID", "muted");
