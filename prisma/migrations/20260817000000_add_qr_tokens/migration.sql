-- 二维码令牌:个人名片 / 独立群聊 / 圈子。扫码准入的授权凭据(UUID 不是授权)。
CREATE TYPE "QrTokenType" AS ENUM ('USER', 'GROUP', 'CIRCLE');

CREATE TABLE "QrToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "type" "QrTokenType" NOT NULL,
    "targetID" TEXT NOT NULL,
    "issuerID" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QrToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "QrToken_token_key" ON "QrToken"("token");

CREATE INDEX "QrToken_type_targetID_issuerID_createdAt_idx" ON "QrToken"("type", "targetID", "issuerID", "createdAt");

ALTER TABLE "QrToken" ADD CONSTRAINT "QrToken_issuerID_fkey" FOREIGN KEY ("issuerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
