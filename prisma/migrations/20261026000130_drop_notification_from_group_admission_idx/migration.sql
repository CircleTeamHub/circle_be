-- 删掉全列的 Notification_fromGroupAdmissionID_idx,由 20261026000100 的部分索引
-- Notification_fromGroupAdmissionID_present_idx (WHERE fromGroupAdmissionID IS NOT NULL)
-- 接替。用到这列的查询:入群审批「已读」(等值)、审批列表未读数(IN 列表)、退群时
-- 清理通知(与 GroupAdmission 的半连接),都隐含 IS NOT NULL。
--
-- 一份迁移只放这一条(见 src/prisma/concurrent-index-migrations.spec.ts)。
DROP INDEX CONCURRENTLY IF EXISTS "Notification_fromGroupAdmissionID_idx";
