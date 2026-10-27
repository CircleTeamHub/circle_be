-- CircleInvitation 两个定时任务的批次查询（src/circle-invitation/circle-invitation-cron.query.ts）。
-- 表上原有索引是 (circleID, status) 与 (applicantID)，都不以 status 打头，两条批次
-- 查询只能整表扫描：
--
-- 1. 每分钟一次的同意制邀请投递：
--      WHERE "status" = 'INVITED' AND "consentNoticeRequired"
--        AND "consentNoticeDeliveredAt" IS NULL AND "consentNoticeAttempts" < $1
--      ORDER BY "consentNoticeAttempts", "createdAt" LIMIT 50
--    部分索引只收待投递的行（投递成功或邀请离开 INVITED 就出索引），平时几乎为空；
--    键序就是查询的排序，读到 LIMIT 条就停。
--
-- 2. 每 5 分钟一次的补偿：
--      WHERE "status" = 'PENDING' AND "approvedCount" >= "requiredCount"
--      ORDER BY "updatedAt", "id" LIMIT 100
--    只收「票够了却还停在 PENDING」的行（请求事务中断才会留下），正常为空。
--
-- 谓词与查询条件必须一字不差：status 是字面量、布尔条件是裸列名、列比较同形。
-- Prisma 生成的枚举条件是 CAST($n::text AS 枚举)，规划期折叠不成常量，用不上这里的
-- 部分索引 —— 所以两条查询都是原生 SQL。部分索引 Prisma schema 表达不了，按仓库
-- 惯例不在 schema.prisma 里声明。
--
-- CONCURRENTLY：邀请表在入圈高峰时写入频繁。文件里只能有普通语句（不能有函数体或
-- DO 块），Prisma 才会把每条语句放在事务外执行。部署后查 pg_index.indisvalid：中断的
-- 并发建索引会留下 indisvalid = false 的残骸，IF NOT EXISTS 会把它当成已建好而跳过，
-- 必须先手动 DROP INDEX CONCURRENTLY 再重跑迁移。

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CircleInvitation_consent_delivery_idx"
ON "CircleInvitation" ("consentNoticeAttempts", "createdAt")
WHERE "status" = 'INVITED'
  AND "consentNoticeRequired"
  AND "consentNoticeDeliveredAt" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "CircleInvitation_reconcile_approved_idx"
ON "CircleInvitation" ("updatedAt", "id")
WHERE "status" = 'PENDING'
  AND "approvedCount" >= "requiredCount";
