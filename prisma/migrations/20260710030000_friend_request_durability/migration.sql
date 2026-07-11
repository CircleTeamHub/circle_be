ALTER TYPE "FriendActivityType" ADD VALUE IF NOT EXISTS 'REQUEST_MESSAGE_RECEIVED';
ALTER TYPE "FriendSyncOperation" ADD VALUE IF NOT EXISTS 'CLEAR_CONVERSATION';

CREATE TYPE "FriendChatReplayStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

ALTER TABLE "Notification"
  ADD COLUMN "fromFriendRequestID" TEXT;

CREATE TABLE "FriendChatReplayOutbox" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "requesterUserID" TEXT NOT NULL,
  "accepterUserID" TEXT NOT NULL,
  "status" "FriendChatReplayStatus" NOT NULL DEFAULT 'PENDING',
  "stage" INTEGER NOT NULL DEFAULT 0,
  "messageIndex" INTEGER NOT NULL DEFAULT 0,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FriendChatReplayOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "FriendChatReplayOutbox_requestId_key"
  ON "FriendChatReplayOutbox" ("requestId");
CREATE INDEX "FriendChatReplayOutbox_status_nextAttemptAt_idx"
  ON "FriendChatReplayOutbox" ("status", "nextAttemptAt");

CREATE INDEX "Notification_fromFriendRequestID_idx"
  ON "Notification" ("fromFriendRequestID");

ALTER TABLE "Notification"
  ADD CONSTRAINT "Notification_fromFriendRequestID_fkey"
  FOREIGN KEY ("fromFriendRequestID") REFERENCES "Friend"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FriendChatReplayOutbox"
  ADD CONSTRAINT "FriendChatReplayOutbox_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "Friend"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
