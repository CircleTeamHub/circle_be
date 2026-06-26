-- Add a nullable cover image column to circles (banner shown on the detail page).
-- Additive + nullable: safe, no backfill, reversible by dropping the column.
-- `0_init` already includes this column for newly-created databases; keep this
-- migration idempotent for older databases that reached the branch before the
-- baseline was regenerated.
ALTER TABLE "Circle" ADD COLUMN IF NOT EXISTS "cover" TEXT;
