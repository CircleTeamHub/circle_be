ALTER TABLE "User"
ADD COLUMN "inviteCode" TEXT,
ADD COLUMN "invitedByUserId" TEXT;

UPDATE "User"
SET "inviteCode" = lower("accountId");

ALTER TABLE "User"
ALTER COLUMN "inviteCode" SET NOT NULL;

ALTER TABLE "User"
ADD CONSTRAINT "User_inviteCode_key" UNIQUE ("inviteCode");

CREATE INDEX "User_invitedByUserId_idx" ON "User"("invitedByUserId");

ALTER TABLE "User"
ADD CONSTRAINT "User_invitedByUserId_fkey"
FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
