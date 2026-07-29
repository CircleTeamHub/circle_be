BEGIN;

ALTER TABLE "Circle"
  ADD COLUMN "expansionSeats" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "Circle_expansionSeats_check"
    CHECK ("expansionSeats" >= 0);

CREATE TABLE "GroupExpansionOrder" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "userID" TEXT NOT NULL,
  "circleID" TEXT NOT NULL,
  "productID" TEXT NOT NULL,
  "productName" TEXT NOT NULL,
  "seats" INTEGER NOT NULL,
  "price" INTEGER NOT NULL,
  "previousMaxMembers" INTEGER NOT NULL,
  "newMaxMembers" INTEGER NOT NULL,
  "walletBalanceAfter" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "GroupExpansionOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "GroupExpansionOrder_seats_check" CHECK ("seats" > 0),
  CONSTRAINT "GroupExpansionOrder_price_check" CHECK ("price" > 0),
  CONSTRAINT "GroupExpansionOrder_capacity_check" CHECK (
    "previousMaxMembers" >= 0
    AND "newMaxMembers" > "previousMaxMembers"
    AND "newMaxMembers" <= 3000
  ),
  CONSTRAINT "GroupExpansionOrder_wallet_check"
    CHECK ("walletBalanceAfter" >= 0)
);

CREATE UNIQUE INDEX "GroupExpansionOrder_idempotencyKey_key"
  ON "GroupExpansionOrder"("idempotencyKey");
CREATE INDEX "GroupExpansionOrder_userID_createdAt_idx"
  ON "GroupExpansionOrder"("userID", "createdAt");
CREATE INDEX "GroupExpansionOrder_circleID_createdAt_idx"
  ON "GroupExpansionOrder"("circleID", "createdAt");

ALTER TABLE "GroupExpansionOrder"
  ADD CONSTRAINT "GroupExpansionOrder_userID_fkey"
  FOREIGN KEY ("userID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "GroupExpansionOrder"
  ADD CONSTRAINT "GroupExpansionOrder_circleID_fkey"
  FOREIGN KEY ("circleID") REFERENCES "Circle"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
