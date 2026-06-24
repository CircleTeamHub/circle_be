-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACTIVE', 'ENDED', 'CANCELED', 'MISSED', 'FAILED');

-- CreateEnum
CREATE TYPE "CallParticipantStatus" AS ENUM ('INVITED', 'JOINED', 'LEFT', 'REJECTED', 'MISSED');

-- CreateEnum
CREATE TYPE "CallEndReason" AS ENUM ('NORMAL', 'CANCELED', 'ALL_LEFT', 'NO_ANSWER', 'TIMEOUT', 'NETWORK', 'ERROR');

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "sessionType" INTEGER NOT NULL,
    "callType" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "livekitRoomName" TEXT NOT NULL,
    "initiatorID" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedByID" TEXT,
    "endReason" "CallEndReason",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallParticipant" (
    "id" TEXT NOT NULL,
    "callID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "status" "CallParticipantStatus" NOT NULL DEFAULT 'INVITED',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "missedAt" TIMESTAMP(3),
    "lastTokenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_livekitRoomName_key" ON "CallSession"("livekitRoomName");

-- CreateIndex
CREATE INDEX "CallSession_conversationID_createdAt_idx" ON "CallSession"("conversationID", "createdAt");

-- CreateIndex
CREATE INDEX "CallSession_initiatorID_status_idx" ON "CallSession"("initiatorID", "status");

-- CreateIndex
CREATE INDEX "CallSession_expiresAt_status_idx" ON "CallSession"("expiresAt", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CallParticipant_callID_userID_key" ON "CallParticipant"("callID", "userID");

-- CreateIndex
CREATE INDEX "CallParticipant_userID_status_idx" ON "CallParticipant"("userID", "status");

-- CreateIndex
CREATE INDEX "CallParticipant_callID_status_idx" ON "CallParticipant"("callID", "status");

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_initiatorID_fkey" FOREIGN KEY ("initiatorID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_callID_fkey" FOREIGN KEY ("callID") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
