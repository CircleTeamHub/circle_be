-- #100: gift-card compensation tracking; #91: membership idempotency key.
ALTER TABLE "CoinGift" ADD COLUMN "cardDeliveredAt" TIMESTAMP(3);
ALTER TABLE "CoinGift" ADD COLUMN "cardAttempts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "CoinTransaction" ADD COLUMN "idempotencyKey" TEXT;
CREATE UNIQUE INDEX "CoinTransaction_idempotencyKey_key" ON "CoinTransaction"("idempotencyKey");
