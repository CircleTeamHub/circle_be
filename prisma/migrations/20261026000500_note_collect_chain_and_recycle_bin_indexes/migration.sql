-- Note 上两条没有可用索引的查询路径。
--
-- 1. 收录链下游：WHERE "collectedFromNoteID" = $1 / IN (...)
--    - 永久删除（回收站「立即删除」与每天 04:00 的到期清理共用 purgeDeletedNote）
--      要把被删笔记的下游副本改指向它的上游；
--    - 来源笔记状态广播沿下游最多走 8 层找副本主人。
--    20260704083000 把旧的 (ownerID, collectedFromNoteID) 换成了以 ownerID 打头、
--    带 status <> 'DELETED' 谓词的部分唯一索引，这两条查询都不带 ownerID，用不上它，
--    每次都是整表扫描。新索引只收有来源的副本（自建笔记该列为 NULL，占大多数）；
--    = / IN 是严格运算符，规划器能从查询条件推出 IS NOT NULL，参数化也照样命中。
--
-- 2. 回收站到期清理：WHERE "status" = 'DELETED' AND "updatedAt" < 截止
--    ORDER BY "updatedAt", "id" LIMIT 200（src/note/note-recycle-bin.query.ts）。
--    原有索引都以 ownerID 打头；到期行稀疏时要走完整张表才凑够一批。部分索引只收
--    回收站里的行，查询里 "status" = 'DELETED' 必须是字面量、与这里一字不差。
--
-- 部分索引 Prisma schema 表达不了，按仓库惯例不在 schema.prisma 里声明。
-- CONCURRENTLY：Note 是写热表。文件里只能有普通语句（不能有函数体或 DO 块），Prisma
-- 才会把每条语句放在事务外执行。部署后查 pg_index.indisvalid：中断的并发建索引会留下
-- indisvalid = false 的残骸，IF NOT EXISTS 会把它当成已建好而跳过，必须先手动
-- DROP INDEX CONCURRENTLY 再重跑迁移。

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Note_collectedFromNoteID_present_idx"
ON "Note" ("collectedFromNoteID")
WHERE "collectedFromNoteID" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Note_recycle_bin_updatedAt_id_idx"
ON "Note" ("updatedAt", "id")
WHERE "status" = 'DELETED';
