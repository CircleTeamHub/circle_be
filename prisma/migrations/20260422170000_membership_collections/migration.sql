ALTER TYPE "CoinTxType" ADD VALUE IF NOT EXISTS 'PURCHASE';

CREATE TYPE "CollectionType" AS ENUM ('CHAT', 'VIDEO', 'VOICE', 'MESSAGE', 'NOTE');

CREATE TABLE "UserCollection" (
  "id" TEXT NOT NULL,
  "userID" TEXT NOT NULL,
  "type" "CollectionType" NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "sourceID" TEXT,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserCollection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserCollection_userID_type_createdAt_idx" ON "UserCollection"("userID", "type", "createdAt");

ALTER TABLE "UserCollection"
ADD CONSTRAINT "UserCollection_userID_fkey"
FOREIGN KEY ("userID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
