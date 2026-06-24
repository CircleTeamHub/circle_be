-- Allow fresh Friend rows for retries after reject/withdraw so old request history
-- and activity records remain attached to the original requestId.
DROP INDEX IF EXISTS "Friend_userID_friendID_key";
CREATE UNIQUE INDEX "Friend_active_pair_key"
ON "Friend"(LEAST("userID", "friendID"), GREATEST("userID", "friendID"))
WHERE "state" IN ('PENDING', 'ACCEPTED');
