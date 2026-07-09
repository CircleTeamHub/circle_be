-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'FRIEND_REQUEST_MESSAGE';

-- CreateTable
CREATE TABLE "FriendRequestMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendRequestMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FriendRequestMessage_requestId_createdAt_idx" ON "FriendRequestMessage"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "FriendRequestMessage" ADD CONSTRAINT "FriendRequestMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendRequestMessage" ADD CONSTRAINT "FriendRequestMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

