-- AlterTable
ALTER TABLE "ChatConversation" ADD COLUMN     "textEncryption" TEXT NOT NULL DEFAULT 'PLAIN';

-- CreateTable
CREATE TABLE "E2eeDevice" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "approvedByID" TEXT,
    "approvalSignature" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "E2eeDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "E2eeKeyPackage" (
    "id" TEXT NOT NULL,
    "deviceID" TEXT NOT NULL,
    "encoded" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "claimedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "E2eeKeyPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "E2eeRoom" (
    "conversationID" TEXT NOT NULL,
    "managerDeviceID" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "E2eeRoom_pkey" PRIMARY KEY ("conversationID")
);

-- CreateTable
CREATE TABLE "E2eeRoomDevice" (
    "conversationID" TEXT NOT NULL,
    "deviceID" TEXT NOT NULL,
    "joinedEpoch" INTEGER NOT NULL,
    "removedEpoch" INTEGER,

    CONSTRAINT "E2eeRoomDevice_pkey" PRIMARY KEY ("conversationID","deviceID")
);

-- CreateTable
CREATE TABLE "E2eeEpochEvent" (
    "id" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL,
    "packet" JSONB NOT NULL,
    "requestHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "E2eeEpochEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "E2eeDevice_userID_purpose_status_idx" ON "E2eeDevice"("userID", "purpose", "status");

-- CreateIndex
CREATE INDEX "E2eeKeyPackage_deviceID_claimedBy_idx" ON "E2eeKeyPackage"("deviceID", "claimedBy");

-- CreateIndex
CREATE INDEX "E2eeRoomDevice_deviceID_removedEpoch_idx" ON "E2eeRoomDevice"("deviceID", "removedEpoch");

-- CreateIndex
CREATE UNIQUE INDEX "E2eeEpochEvent_conversationID_epoch_key" ON "E2eeEpochEvent"("conversationID", "epoch");

-- AddForeignKey
ALTER TABLE "E2eeKeyPackage" ADD CONSTRAINT "E2eeKeyPackage_deviceID_fkey" FOREIGN KEY ("deviceID") REFERENCES "E2eeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "E2eeRoom" ADD CONSTRAINT "E2eeRoom_conversationID_fkey" FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "E2eeRoomDevice" ADD CONSTRAINT "E2eeRoomDevice_conversationID_fkey" FOREIGN KEY ("conversationID") REFERENCES "E2eeRoom"("conversationID") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "E2eeRoomDevice" ADD CONSTRAINT "E2eeRoomDevice_deviceID_fkey" FOREIGN KEY ("deviceID") REFERENCES "E2eeDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "E2eeEpochEvent" ADD CONSTRAINT "E2eeEpochEvent_conversationID_fkey" FOREIGN KEY ("conversationID") REFERENCES "E2eeRoom"("conversationID") ON DELETE CASCADE ON UPDATE CASCADE;

