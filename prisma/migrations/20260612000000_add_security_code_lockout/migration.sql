-- Persistent per-account brute-force lockout for the login security code.
ALTER TABLE "User" ADD COLUMN "securityCodeAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD COLUMN "securityCodeLockedUntil" TIMESTAMP(3);
