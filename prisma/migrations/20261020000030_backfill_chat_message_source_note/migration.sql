-- 回填 ChatMessage."sourceNoteID"(列在 20261020000010 加好、已提交)。
--
-- 存量卡片优先用 content.sourceNoteId;只有 content.noteId 的老卡片,按
-- 20261020000020 回填好的 Note 根解析。要排在那份之后。
--
-- 只拿被改那些行的行锁,不设 lock_timeout;聊天读写和新消息照常进行。
-- 只改 sourceNoteID,不动 content / deleted / revokedAt / editedAt / burnExpiresAt,
-- revision 触发器不会给这些消息换新序号,客户端不会因此重新同步。
UPDATE "ChatMessage" AS message
SET "sourceNoteID" = COALESCE(
  NULLIF(message."content"->>'sourceNoteId', ''),
  (
    SELECT COALESCE(note."rootSourceNoteID", note."id")
    FROM "Note" AS note
    WHERE note."id" = NULLIF(message."content"->>'noteId', '')
  ),
  NULLIF(message."content"->>'noteId', '')
)
WHERE message."type" = 'note-card';
