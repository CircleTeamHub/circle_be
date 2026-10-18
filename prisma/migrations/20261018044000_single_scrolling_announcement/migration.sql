WITH ranked AS (
  SELECT "id", row_number() OVER (ORDER BY "createdAt" DESC, "id" DESC) AS position
  FROM "SystemAnnouncement" WHERE "scrolling" = true
)
UPDATE "SystemAnnouncement" SET "scrolling" = false WHERE "id" IN (SELECT "id" FROM ranked WHERE position > 1);
CREATE UNIQUE INDEX "SystemAnnouncement_single_scrolling" ON "SystemAnnouncement" ("scrolling") WHERE "scrolling" = true;
