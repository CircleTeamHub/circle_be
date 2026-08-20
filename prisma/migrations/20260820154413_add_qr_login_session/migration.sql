-- 网页扫码登录会话（双令牌：qrToken 进二维码，pollKey 只留网页端）
-- CreateEnum
CREATE TYPE "QrLoginStatus" AS ENUM ('PENDING', 'APPROVED', 'CONSUMED');

-- CreateTable
CREATE TABLE "QrLoginSession" (
    "id" TEXT NOT NULL,
    "qrToken" TEXT NOT NULL,
    "pollKey" TEXT NOT NULL,
    "status" "QrLoginStatus" NOT NULL DEFAULT 'PENDING',
    "approvedByID" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "QrLoginSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QrLoginSession_qrToken_key" ON "QrLoginSession"("qrToken");

-- CreateIndex
CREATE UNIQUE INDEX "QrLoginSession_pollKey_key" ON "QrLoginSession"("pollKey");

-- CreateIndex
CREATE INDEX "QrLoginSession_expiresAt_idx" ON "QrLoginSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "QrLoginSession" ADD CONSTRAINT "QrLoginSession_approvedByID_fkey" FOREIGN KEY ("approvedByID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
