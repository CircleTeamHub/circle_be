-- 笔记来源状态广播要找出「哪些会话里还有指向这些笔记的有效卡片」。原先用 Prisma
-- 的 JSON path 过滤，生成 (content#>ARRAY[...])::jsonb = $n，ChatMessage 上没有
-- 任何索引能接住：老板每改一次开工/打烊/上下架，都要扫一遍全库最大的表。
--
-- 每个来源指针键一条部分表达式索引（sourceNoteId 是现行字段，noteId 是老卡片的
-- 来源指针）。查询在 src/note/note-card-recipients.query.ts，表达式与 WHERE 必须
-- 和这里一字不差，且 type / deleted 写成字面量，否则规划器用不上部分索引。
-- 部分/表达式索引 Prisma schema 表达不了，按仓库惯例不在 schema.prisma 里声明。
--
-- ChatMessage 写入繁忙，所以用 CONCURRENTLY；文件里只能有普通语句（不能有函数体
-- 或 DO 块），Prisma 才会把每条语句放在事务外执行。部署后检查 pg_index.indisvalid：
-- 中断的并发建索引会留下 indisvalid = false 的残骸，IF NOT EXISTS 会把它当成已建好
-- 而跳过，必须先手动 DROP INDEX CONCURRENTLY 再重跑迁移。

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_note_card_sourceNoteId_idx"
ON "ChatMessage" (("content" ->> 'sourceNoteId'))
WHERE "type" = 'note-card' AND "deleted" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_note_card_noteId_idx"
ON "ChatMessage" (("content" ->> 'noteId'))
WHERE "type" = 'note-card' AND "deleted" = false;
