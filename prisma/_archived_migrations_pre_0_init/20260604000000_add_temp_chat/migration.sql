-- CreateEnum
CREATE TYPE "TempChatStatus" AS ENUM ('ACTIVE', 'ENDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "TempChat" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '临时聊天',
    "status" "TempChatStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxMembers" INTEGER NOT NULL DEFAULT 50,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TempChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TempChatGuest" (
    "id" TEXT NOT NULL,
    "tempChatId" TEXT NOT NULL,
    "imUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleanedUp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TempChatGuest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TempChat_groupId_key" ON "TempChat"("groupId");

-- CreateIndex
CREATE INDEX "TempChat_status_expiresAt_idx" ON "TempChat"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "TempChat_hostUserId_idx" ON "TempChat"("hostUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TempChatGuest_imUserId_key" ON "TempChatGuest"("imUserId");

-- CreateIndex
CREATE INDEX "TempChatGuest_tempChatId_idx" ON "TempChatGuest"("tempChatId");

-- AddForeignKey
ALTER TABLE "TempChatGuest" ADD CONSTRAINT "TempChatGuest_tempChatId_fkey" FOREIGN KEY ("tempChatId") REFERENCES "TempChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
