-- Add the PARTNER value to the SystemIconKey enum. schema.prisma declares
-- SystemIconKey { VIP, NEW_USER, PARTNER } but 0_init only created ('VIP','NEW_USER'),
-- so persisting a PARTNER display-icon selection (UserDisplayIcon.systemKey) would fail
-- with Postgres 22P02 "invalid input value for enum". IF NOT EXISTS keeps it idempotent.
ALTER TYPE "SystemIconKey" ADD VALUE IF NOT EXISTS 'PARTNER';

-- Replace the single-column fromUserID index with a composite (fromUserID, likedOn) that
-- backs the per-day like-quota count; its leftmost prefix still serves fromUserID-only lookups.
DROP INDEX IF EXISTS "UserLike_fromUserID_idx";
CREATE INDEX IF NOT EXISTS "UserLike_fromUserID_likedOn_idx" ON "UserLike"("fromUserID", "likedOn");
