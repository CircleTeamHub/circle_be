-- CreateEnum
CREATE TYPE "CoinTxType" AS ENUM ('RECHARGE', 'GIFT_SENT', 'GIFT_RECEIVED', 'REFUND', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "Friend" ADD COLUMN     "remarkA" TEXT,
ADD COLUMN     "remarkB" TEXT;

-- CreateTable
CREATE TABLE "FriendTag" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendTagOnFriend" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "tagID" TEXT NOT NULL,
    "friendID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendTagOnFriend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinTransaction" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "type" "CoinTxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "note" TEXT,
    "relatedID" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinGift" (
    "id" TEXT NOT NULL,
    "senderID" TEXT NOT NULL,
    "recipientID" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinGift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FriendTag_ownerID_idx" ON "FriendTag"("ownerID");

-- CreateIndex
CREATE UNIQUE INDEX "FriendTag_ownerID_name_key" ON "FriendTag"("ownerID", "name");

-- CreateIndex
CREATE INDEX "FriendTagOnFriend_ownerID_friendID_idx" ON "FriendTagOnFriend"("ownerID", "friendID");

-- CreateIndex
CREATE UNIQUE INDEX "FriendTagOnFriend_ownerID_tagID_friendID_key" ON "FriendTagOnFriend"("ownerID", "tagID", "friendID");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userID_key" ON "Wallet"("userID");

-- CreateIndex
CREATE INDEX "CoinTransaction_userID_createdAt_idx" ON "CoinTransaction"("userID", "createdAt");

-- CreateIndex
CREATE INDEX "CoinGift_senderID_idx" ON "CoinGift"("senderID");

-- CreateIndex
CREATE INDEX "CoinGift_recipientID_idx" ON "CoinGift"("recipientID");

-- AddForeignKey
ALTER TABLE "FriendTag" ADD CONSTRAINT "FriendTag_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTagOnFriend" ADD CONSTRAINT "FriendTagOnFriend_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTagOnFriend" ADD CONSTRAINT "FriendTagOnFriend_tagID_fkey" FOREIGN KEY ("tagID") REFERENCES "FriendTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTagOnFriend" ADD CONSTRAINT "FriendTagOnFriend_friendID_fkey" FOREIGN KEY ("friendID") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinTransaction" ADD CONSTRAINT "CoinTransaction_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinGift" ADD CONSTRAINT "CoinGift_senderID_fkey" FOREIGN KEY ("senderID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinGift" ADD CONSTRAINT "CoinGift_recipientID_fkey" FOREIGN KEY ("recipientID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
