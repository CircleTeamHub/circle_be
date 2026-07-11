-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'FRIEND_REQUEST_MESSAGE';

-- CreateTable
CREATE TABLE IF NOT EXISTS "FriendRequestMessage" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendRequestMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "FriendRequestMessage_requestId_createdAt_idx" ON "FriendRequestMessage"("requestId", "createdAt");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FriendRequestMessage_requestId_fkey') THEN
    ALTER TABLE "FriendRequestMessage" ADD CONSTRAINT "FriendRequestMessage_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FriendRequestMessage_senderId_fkey') THEN
    ALTER TABLE "FriendRequestMessage" ADD CONSTRAINT "FriendRequestMessage_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
