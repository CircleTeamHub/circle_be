ALTER TABLE "RefreshToken"
ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN "accessRevokedAt" TIMESTAMP(3);
