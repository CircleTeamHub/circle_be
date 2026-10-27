-- 两条指向圈子图标的引用列没有以它打头的索引。
--
-- 1. UserDisplayIcon."circleID"
--    解散圈子（Serializable 事务里）执行 DELETE FROM "UserDisplayIcon" WHERE "circleID" = $1，
--    圈子硬删时外键 ON DELETE CASCADE 也按它找行。表上只有 (userID, circleID) 唯一索引
--    和 (userID, sortOrder)，都以 userID 打头，按 circleID 删只能整表扫描 ——
--    Serializable 下整表扫描还会给整张表记谓词锁，和所有佩戴图标的写互相冲突。
--
-- 2. Circle."currentIconAssetID"（外键 → IconAsset，ON DELETE SET NULL）
--    上传新圈子图标会删掉旧的 IconAsset；每删一行，外键的引用完整性触发器都要执行
--    UPDATE "Circle" SET "currentIconAssetID" = NULL WHERE "currentIconAssetID" = $1，
--    没有索引就是对 Circle 整表扫描。
--
-- 两列绝大多数行是 NULL（系统徽章没有 circleID；没上传过图标的圈子没有当前图标），
-- 所以只收非 NULL 行。等值条件用的是严格运算符，规划器能推出 IS NOT NULL，参数化的
-- 查询和外键触发器缓存的通用计划都能命中部分索引。部分索引 Prisma schema 表达不了，
-- 按仓库惯例不在 schema.prisma 里声明。
--
-- CONCURRENTLY：Circle 是写热表（计数列）。文件里只能有普通语句（不能有函数体或
-- DO 块），Prisma 才会把每条语句放在事务外执行。部署后查 pg_index.indisvalid：中断的
-- 并发建索引会留下 indisvalid = false 的残骸，IF NOT EXISTS 会把它当成已建好而跳过，
-- 必须先手动 DROP INDEX CONCURRENTLY 再重跑迁移。

CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserDisplayIcon_circleID_present_idx"
ON "UserDisplayIcon" ("circleID")
WHERE "circleID" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Circle_currentIconAssetID_present_idx"
ON "Circle" ("currentIconAssetID")
WHERE "currentIconAssetID" IS NOT NULL;
