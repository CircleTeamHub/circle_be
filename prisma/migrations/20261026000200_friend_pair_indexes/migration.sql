-- Friend 的两个复合索引(配套删单列索引见 20261026000230 / 20261026000240)。
--
-- 「两人之间有没有关系」是 Friend 上最常见的查询:
--   WHERE ("userID" = a AND "friendID" = b) OR ("userID" = b AND "friendID" = a)
-- friend.service 多处、src/chat/standalone-group-policy-gate.ts、发好友申请的事务
-- (持着 pair advisory 锁)都这么查。原先只有 ("userID")、("friendID") 两个单列
-- 索引:按一侧取出这个人的全部关系行再逐行回表比对另一侧,好友越多越慢。两个方向
-- 各一个复合索引后,OR 的两支各是一次精确探测(BitmapOr)。
--
-- 只按一侧查的语句(好友列表 userID = $1 OR friendID = $1、删用户时的外键级联)
-- 用复合索引的前导列,所以单列索引随后可以删掉。
--
-- CONCURRENTLY:Friend 是线上写表。文件里只有 CREATE INDEX CONCURRENTLY,Prisma 才会
-- 逐条放在事务外执行(不能写函数体 / DO 块)。部署后查 pg_index.indisvalid:中断的
-- 并发建索引会留下 invalid 索引,IF NOT EXISTS 会把它当成已存在 —— 遇到要先手动
-- DROP INDEX CONCURRENTLY 再重跑,并且在两个复合索引都 valid 之前不要部署后面两个
-- 删单列索引的迁移。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Friend_userID_friendID_idx"
ON "Friend" ("userID", "friendID");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Friend_friendID_userID_idx"
ON "Friend" ("friendID", "userID");
