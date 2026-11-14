-- 笔记回收站取消、两种「下架」合并、下架满 60 天自动删除。
--
-- 1. Note."unlistedAt":这次进入下架(status = 'UNLISTED')的时刻,上架时为 NULL。可空、无默认值,
--    只改目录。Note 是热表:ACCESS EXCLUSIVE 等不到 5 秒就失败;失败时先
--    `npx prisma migrate resolve --rolled-back 20261113130000_note_unlisted_lifecycle`,
--    避开长事务后重跑 migrate deploy。
SET lock_timeout = '5s';

ALTER TABLE "Note" ADD COLUMN "unlistedAt" TIMESTAMP(3);

-- 2. 两种下架合并成 status = 'UNLISTED'。场地标记 workStatus = 'OFF_SHELF' 的上架笔记转成下架;
--    本来就下架/已删除、又带着旧标记的,只清掉标记(合并后它没有含义,也不再写入)。
--    行很少(测试阶段),只拿行锁。
UPDATE "Note" SET "status" = 'UNLISTED', "workStatus" = NULL
WHERE "workStatus" = 'OFF_SHELF' AND "status" = 'ACTIVE';

UPDATE "Note" SET "workStatus" = NULL WHERE "workStatus" = 'OFF_SHELF';

-- 3. 上线时已经下架的笔记,60 天从这次部署起算,而不是原来的下架日期。
UPDATE "Note" SET "unlistedAt" = now()
WHERE "status" = 'UNLISTED' AND "unlistedAt" IS NULL;

RESET lock_timeout;

-- 4. NoteCleanup 找到期下架笔记:WHERE "status" = 'UNLISTED' AND "unlistedAt" <= 截止
--    ORDER BY "unlistedAt", "id"(src/note/note-cleanup.query.ts)。部分索引只收下架的行,
--    查询里 "status" = 'UNLISTED' 必须是字面量、与这里一字不差;Prisma schema 表达不了,
--    按仓库惯例不在 schema.prisma 里声明。已删除笔记的清理沿用 20261026000500 的
--    "Note_recycle_bin_updatedAt_id_idx"。
--    CONCURRENTLY:文件里没有函数体 / DO 块,Prisma 逐条执行。lock_timeout 已经 RESET,
--    并发建索引等旧事务时不会被它打断。部署后查 pg_index.indisvalid:中断留下的 invalid
--    索引会被 IF NOT EXISTS 跳过,要先 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Note_unlisted_unlistedAt_id_idx"
ON "Note" ("unlistedAt", "id")
WHERE "status" = 'UNLISTED';
