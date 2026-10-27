-- 删掉全列的 Notification_fromFriendRequestID_idx,由 20261026000100 的部分索引
-- Notification_fromFriendRequestID_present_idx (WHERE fromFriendRequestID IS NOT NULL)
-- 接替。这列只被外键 ON DELETE SET NULL(Friend 删除时按等值找引用行)用到,等值条件
-- 隐含 IS NOT NULL。
--
-- 一份迁移只放这一条(见 src/prisma/concurrent-index-migrations.spec.ts)。
DROP INDEX CONCURRENTLY IF EXISTS "Notification_fromFriendRequestID_idx";
