-- Admin console brute-force lockout (#83): per-account failed-attempt counter
-- and lock horizon, mirroring the existing securityCode* pair.
ALTER TABLE "User" ADD COLUMN "adminLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "adminLoginLockedUntil" TIMESTAMP(3);
