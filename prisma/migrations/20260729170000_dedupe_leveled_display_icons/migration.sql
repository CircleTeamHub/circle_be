-- VIP and Top Collaborator are single display slots whose stored tier follows
-- the user's current effective tier. Older rows may contain several historical
-- variants; keep the first displayed row so normalization cannot emit the same
-- current badge more than once.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userID", "systemKey"
      ORDER BY "sortOrder" ASC, "createdAt" ASC, "id" ASC
    ) AS "rowNumber"
  FROM "UserDisplayIcon"
  WHERE "displayType" = 'SYSTEM'
    AND "systemKey" IN ('VIP', 'TOP_COLLABORATOR')
)
DELETE FROM "UserDisplayIcon" AS target
USING ranked
WHERE target."id" = ranked."id"
  AND ranked."rowNumber" > 1;

-- Keep the invariant at the database boundary. Other system badge families may
-- still introduce independently selectable variants in the future.
CREATE UNIQUE INDEX IF NOT EXISTS "UserDisplayIcon_userID_leveled_systemKey_key"
ON "UserDisplayIcon"("userID", "systemKey")
WHERE "displayType" = 'SYSTEM'
  AND "systemKey" IN ('VIP', 'TOP_COLLABORATOR');
