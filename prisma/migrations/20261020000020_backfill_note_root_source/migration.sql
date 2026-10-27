-- 回填 Note."rootSourceNoteID"(列在 20261020000000 加好、已提交)。
--
-- 只拿行锁(UPDATE 的 ROW EXCLUSIVE 表锁不挡别的读写),所以不设 lock_timeout;
-- 和 ChatMessage 的回填(20261020000030)分开提交,收藏副本的行锁不会陪着去扫消息表。
-- 沿收藏链最多走 64 层取最远的祖先,path 防环。
WITH RECURSIVE ancestry AS (
  SELECT
    note."id" AS "descendantID",
    note."collectedFromNoteID" AS "ancestorID",
    note."collectedFromNoteID" AS "rootID",
    1 AS depth,
    ARRAY[note."id"]::TEXT[] AS path
  FROM "Note" AS note
  WHERE note."collectedFromNoteID" IS NOT NULL

  UNION ALL

  SELECT
    ancestry."descendantID",
    parent."collectedFromNoteID" AS "ancestorID",
    parent."id" AS "rootID",
    ancestry.depth + 1,
    ancestry.path || parent."id"
  FROM ancestry
  JOIN "Note" AS parent ON parent."id" = ancestry."ancestorID"
  WHERE ancestry.depth < 64
    AND NOT parent."id" = ANY(ancestry.path)
), resolved AS (
  SELECT DISTINCT ON ("descendantID")
    "descendantID",
    "rootID"
  FROM ancestry
  ORDER BY "descendantID", depth DESC
)
UPDATE "Note" AS note
SET "rootSourceNoteID" = resolved."rootID"
FROM resolved
WHERE note."id" = resolved."descendantID";
