-- 推送 outbox 出队查询(src/notification/notification-push-outbox.query.ts)的两个部分索引,
-- 都只收「待发」的行(PENDING / FAILED / PROCESSING):COMPLETED / TERMINAL 是表里的
-- 绝大多数,出索引之后索引大小只随积压走。
--
-- 1. fairness_queue:(fairnessKey, createdAt, id)
--    - 递归 CTE 沿 fairnessKey 做 loose index scan,逐个跳到下一个有待发行的分区;
--    - 每个分区 LATERAL 按 (createdAt, id) 顺序取前「配额」条,读够就停。
-- 2. legacy_queue:fairnessKey 为 NULL 的老行(迁移前写入)。兜底分支只扫它,
--    老积压排空后近乎为空;回执轮询把老的 COMPLETED 行拉回 PENDING 时也会落进来。
--
-- 谓词与查询条件必须一字不差:status 是字面量(Prisma 生成的枚举条件是
-- CAST($n::text AS 枚举),规划期证明不了部分索引,所以出队查询是原生 SQL)。
-- 部分索引 Prisma schema 表达不了,按仓库惯例不在 schema.prisma 里声明。
--
-- CONCURRENTLY:每条通知都会写这张表,出队每分钟也在改状态。文件里只能有普通语句
-- (不能有函数体或 DO 块),Prisma 才会把每条语句放在事务外执行。部署后查
-- pg_index.indisvalid:中断的并发建索引会留下 indisvalid = false 的残骸,
-- IF NOT EXISTS 会把它当成已建好而跳过,必须先手动 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "NotificationPushOutbox_fairness_queue_idx"
ON "NotificationPushOutbox" ("fairnessKey", "createdAt", "id")
WHERE "fairnessKey" IS NOT NULL
  AND "status" IN ('PENDING', 'FAILED', 'PROCESSING');

CREATE INDEX CONCURRENTLY IF NOT EXISTS "NotificationPushOutbox_legacy_queue_idx"
ON "NotificationPushOutbox" ("createdAt", "id")
WHERE "fairnessKey" IS NULL
  AND "status" IN ('PENDING', 'FAILED', 'PROCESSING');
