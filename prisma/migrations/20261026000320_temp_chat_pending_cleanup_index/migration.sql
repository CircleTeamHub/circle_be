-- 临时房清理每分钟认领一批「已结束、还没清理完」的房间(src/temp-chat/temp-chat-cleanup.query.ts
-- 的第二支)。TempChat 从不删行,原有的 (status, expiresAt) 索引里 ENDED/EXPIRED 前缀
-- 下是全部历史房间,每轮都要逐行回表看 cleanupCompletedAt。部分索引只收待清理的房间,
-- 清理完成(cleanupCompletedAt 落值)就离开索引,平时几乎是空的;按 expiresAt 排序,
-- 认领时顺着索引取前 N 条即可。
--
-- 谓词里的枚举必须和查询一样是字面量:Prisma 生成的 CAST($1::text AS "TempChatStatus")
-- 走 enum_in(STABLE),规划时折不成常量,证明不了部分索引的谓词 —— 所以那一支是原生 SQL。
--
-- CONCURRENTLY:文件里不能有函数体或 DO 块,Prisma 才会把语句放在事务外执行。部署后查
-- pg_index.indisvalid,中断的并发建索引会留下 invalid 索引,IF NOT EXISTS 会把它当成
-- 已存在 —— 遇到要先手动 DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "TempChat_pending_cleanup_expiresAt_idx"
ON "TempChat" ("expiresAt")
WHERE "cleanupCompletedAt" IS NULL AND "status" IN ('ENDED', 'EXPIRED');
