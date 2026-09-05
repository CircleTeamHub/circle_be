ALTER TABLE "UserPrivacySetting"
ADD COLUMN "directMessageAutoReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "directMessageAutoReplyText" VARCHAR(200) NOT NULL DEFAULT '';

CREATE TYPE "ChatDirectAutoReplyJobStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

CREATE TABLE "ChatDirectAutoReplyJob" (
    "id" TEXT NOT NULL,
    "sourceMessageID" TEXT NOT NULL,
    "status" "ChatDirectAutoReplyJobStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lastError" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatDirectAutoReplyJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChatDirectAutoReplyState" (
    "id" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "responderID" TEXT NOT NULL,
    "lastRepliedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChatDirectAutoReplyState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChatDirectAutoReplyJob_sourceMessageID_key" ON "ChatDirectAutoReplyJob"("sourceMessageID");
CREATE INDEX "ChatDirectAutoReplyJob_status_nextAttemptAt_createdAt_idx" ON "ChatDirectAutoReplyJob"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "ChatDirectAutoReplyJob_status_updatedAt_idx" ON "ChatDirectAutoReplyJob"("status", "updatedAt");
CREATE UNIQUE INDEX "ChatDirectAutoReplyState_conversationID_responderID_key" ON "ChatDirectAutoReplyState"("conversationID", "responderID");
CREATE INDEX "ChatDirectAutoReplyState_responderID_lastRepliedAt_idx" ON "ChatDirectAutoReplyState"("responderID", "lastRepliedAt");
CREATE INDEX "ChatDirectAutoReplyState_updatedAt_idx" ON "ChatDirectAutoReplyState"("updatedAt");

ALTER TABLE "ChatDirectAutoReplyJob"
ADD CONSTRAINT "ChatDirectAutoReplyJob_sourceMessageID_fkey"
FOREIGN KEY ("sourceMessageID") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatDirectAutoReplyState"
ADD CONSTRAINT "ChatDirectAutoReplyState_conversationID_fkey"
FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChatDirectAutoReplyState"
ADD CONSTRAINT "ChatDirectAutoReplyState_responderID_fkey"
FOREIGN KEY ("responderID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
