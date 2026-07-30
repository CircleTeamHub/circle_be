BEGIN;

ALTER TABLE "FancyNumber"
ADD COLUMN "isRecommended" BOOLEAN NOT NULL DEFAULT false;

WITH recommendations AS (
  SELECT "id"
  FROM "FancyNumber"
  WHERE "value" ~ '^[a-z0-9]{6}$'
  ORDER BY "sortOrder" ASC, "id" ASC
  LIMIT 100
)
UPDATE "FancyNumber" AS fancy_number
SET "isRecommended" = true
FROM recommendations
WHERE fancy_number."id" = recommendations."id";

CREATE INDEX "FancyNumber_recommended_status_sort_idx"
ON "FancyNumber" ("isRecommended", "status", "sortOrder", "id");

COMMIT;
