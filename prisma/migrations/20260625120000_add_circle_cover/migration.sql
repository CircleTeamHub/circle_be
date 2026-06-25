-- Add a nullable cover image column to circles (banner shown on the detail page).
-- Additive + nullable: safe, no backfill, reversible by dropping the column.
ALTER TABLE "Circle" ADD COLUMN "cover" TEXT;
