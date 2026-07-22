-- #100: gift-card compensation tracking; #91: membership idempotency key.
ALTER TABLE "CoinGift" ADD COLUMN "cardDeliveredAt" TIMESTAMP(3);
ALTER TABLE "CoinGift" ADD COLUMN "cardAttempts" INTEGER NOT NULL DEFAULT 0;

-- review 修复（P1）：存量礼物的卡片当年都由客户端 IM 已发 —— 不回填的话，
-- 补偿 cron 上线即把全部历史礼物当「未发卡」按 50 行/分钟重发一遍。
-- 上线后的新礼物才进入「回执缺席 → 服务端补发」闭环。
UPDATE "CoinGift" SET "cardDeliveredAt" = "createdAt" WHERE "cardDeliveredAt" IS NULL;

ALTER TABLE "CoinTransaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "CoinTransaction_idempotencyKey_key" ON "CoinTransaction"("idempotencyKey");
