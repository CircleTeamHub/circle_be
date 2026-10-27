-- Notification 上三个索引的替换件。旧索引由随后三份迁移各删一个
-- (20261026000110 / 0120 / 0130):DROP INDEX CONCURRENTLY 一份迁移只能放一条。
--
-- CONCURRENTLY:Notification 是写热表。文件里只有 CREATE INDEX CONCURRENTLY,
-- 不能有函数体或 DO 块,Prisma 才会把每条语句放在事务外逐条执行。部署后查
-- pg_index.indisvalid,中断的并发建索引会留下 invalid 索引,IF NOT EXISTS 会把它
-- 当成已存在 —— 遇到要先手动 DROP INDEX CONCURRENTLY 再重跑。

-- 1. 通知列表:WHERE toUserID = ? AND deleted = false AND type IN (...)
--    ORDER BY createdAt DESC, id DESC。旧的 Notification_active_recipient_created_idx
--    不含 type,只能逐行回表判断类型 —— 大号打开「系统通知」(只要 SYSTEM)时要把
--    90 天的行全部回表一遍。type 放在最后一个 key 列(不能用 INCLUDE:INCLUDE 列
--    不参与索引条件):
--    - 单个类型(type = 'SYSTEM')直接成为索引条件,不匹配的行在索引里就跳过;
--    - 多个类型时 PostgreSQL 16 不把非首列的 IN 当有序索引条件,列表因此先只扫
--      (id, createdAt)(notificationPageScanQuery),走 Index Only Scan,type 在索引
--      元组上过滤,同样不回表。
--    前三列与旧索引相同,旧索引的所有用途(游标行比较、去重窗口查询)它都覆盖。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_active_recipient_created_type_idx"
ON "Notification" ("toUserID", "createdAt" DESC, "id" DESC, "type")
WHERE "deleted" = false;

-- 2. 好友申请 / 入群审批外键:绝大多数通知这两列是 NULL,全列索引的大头是 NULL 条目。
--    所有用到它们的查询都是等值 / IN / 半连接(外键 ON DELETE 动作也是等值),
--    隐含 IS NOT NULL,部分索引照样可用。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_fromFriendRequestID_present_idx"
ON "Notification" ("fromFriendRequestID")
WHERE "fromFriendRequestID" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Notification_fromGroupAdmissionID_present_idx"
ON "Notification" ("fromGroupAdmissionID")
WHERE "fromGroupAdmissionID" IS NOT NULL;
