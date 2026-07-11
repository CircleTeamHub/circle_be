-- Multi-city support for circle posts.
-- Additive + non-destructive: keep the legacy single `city` (now the primary
-- city = cities[0]) so old clients/queries keep working, add `cities[]` as the
-- multi-select source of truth.

ALTER TABLE "CirclePost" ADD COLUMN "cities" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: an existing single city becomes the first (and only) element.
UPDATE "CirclePost"
SET "cities" = ARRAY["city"]
WHERE "city" IS NOT NULL AND "city" <> '';

-- GIN index for array-overlap filtering (cities && filter / hasSome / has).
CREATE INDEX "CirclePost_cities_idx" ON "CirclePost" USING GIN ("cities");
