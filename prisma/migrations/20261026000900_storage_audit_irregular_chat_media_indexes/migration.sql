-- 存量对象盘点（StorageAuditService）反查聊天媒体引用用的两条部分索引。
--
-- 盘点改成按 S3 列举的一批 key 反查「有没有被引用」：活消息与焚毁归档里以 'chat/'
-- 开头的 key / thumbKey 走 20261019000300 的四条表达式索引（值即 object key）。
-- 原来的判定还算进了两类那四条索引看不见的行，这里各建一条部分索引兜住，盘点按 id
-- 把它们读出来照原规则还原 key：
-- - 带着 key 的墓碑（deleted = true）：正常焚毁会把 content 清成 {}，这一类应当一行
--   都没有，兜的是历史 / 意外数据；
-- - 不以 'chat/' 开头的 key / thumbKey（URL、前导 /、早期别的前缀）：发送校验早已
--   只收 chat/{senderId}/，同样应当为空。
-- 两条索引正常情况下都是空的，写入时只多一次谓词判断。谓词必须与
-- src/upload/storage-audit.query.ts 里的查询逐字一致，否则规划器证明不了部分索引。
--
-- CONCURRENTLY：两张都是线上写表。文件里只有 CREATE INDEX CONCURRENTLY，Prisma 才会
-- 逐条放在事务外执行（不能写函数体 / DO 块）。部署后查 pg_index.indisvalid：中断的
-- 并发建索引会留下 invalid 索引，IF NOT EXISTS 会把它当成已存在 —— 遇到要先手动
-- DROP INDEX CONCURRENTLY 再重跑。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_audit_irregular_media_idx"
ON "ChatMessage" ("id")
WHERE "type" IN ('image', 'video', 'voice', 'file')
  AND (
    ("deleted" = true
      AND (("content" ->> 'key') IS NOT NULL
           OR ("content" ->> 'thumbKey') IS NOT NULL))
    OR left("content" ->> 'key', 5) <> 'chat/'
    OR left("content" ->> 'thumbKey', 5) <> 'chat/'
  );

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatBurnArchive_audit_irregular_media_idx"
ON "ChatBurnArchive" ("id")
WHERE "type" IN ('image', 'video', 'voice', 'file')
  AND (
    left("content" ->> 'key', 5) <> 'chat/'
    OR left("content" ->> 'thumbKey', 5) <> 'chat/'
  );
