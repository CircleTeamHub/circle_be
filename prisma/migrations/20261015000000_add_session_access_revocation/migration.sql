ALTER TABLE "RefreshToken"
ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "accessRevokedAt" TIMESTAMP(3),
ADD COLUMN "accessRevocationNotifiedAt" TIMESTAMP(3),
ADD COLUMN "accessRevocationLockedAt" TIMESTAMP(3),
ADD COLUMN "accessRevocationLeaseToken" TEXT;
