-- Historical non-self invitations do not distinguish QR entry from direct invites.
ALTER TABLE "CircleInvitation" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'UNKNOWN';
UPDATE "CircleInvitation" SET "source" = 'APPLICATION' WHERE "applicantID" = "inviterID";

CREATE TABLE "ChatGroupJoinBan" (
    "conversationID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "actorID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ChatGroupJoinBan_pkey" PRIMARY KEY ("conversationID", "userID")
);

ALTER TABLE "ChatGroupJoinBan" ADD CONSTRAINT "ChatGroupJoinBan_conversationID_fkey"
    FOREIGN KEY ("conversationID") REFERENCES "ChatConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
