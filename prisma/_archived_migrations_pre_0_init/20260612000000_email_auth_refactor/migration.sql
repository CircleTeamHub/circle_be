-- CreateEnum
CREATE TYPE "EmailCodePurpose" AS ENUM ('REGISTER', 'LOGIN');

-- CreateTable
CREATE TABLE "EmailVerificationCode" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "codeHash" TEXT NOT NULL,
  "purpose" "EmailCodePurpose" NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailVerificationCode_email_purpose_idx" ON "EmailVerificationCode"("email", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
