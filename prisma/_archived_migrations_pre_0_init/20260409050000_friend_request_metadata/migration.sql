-- Add sender-owned pending remark storage on the Friend record.
ALTER TABLE "Friend"
ADD COLUMN "pendingRemarkBySender" TEXT;

-- Keep sender-owned pending tags keyed by request id.
CREATE TABLE "PendingFriendTagOnRequest" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "requestID" TEXT NOT NULL,
    "tagID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingFriendTagOnRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PendingFriendTagOnRequest_ownerID_requestID_idx" ON "PendingFriendTagOnRequest"("ownerID", "requestID");
CREATE INDEX "PendingFriendTagOnRequest_requestID_idx" ON "PendingFriendTagOnRequest"("requestID");
CREATE UNIQUE INDEX "PendingFriendTagOnRequest_ownerID_requestID_tagID_key" ON "PendingFriendTagOnRequest"("ownerID", "requestID", "tagID");

ALTER TABLE "PendingFriendTagOnRequest" ADD CONSTRAINT "PendingFriendTagOnRequest_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PendingFriendTagOnRequest" ADD CONSTRAINT "PendingFriendTagOnRequest_requestID_fkey" FOREIGN KEY ("requestID") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PendingFriendTagOnRequest" ADD CONSTRAINT "PendingFriendTagOnRequest_tagID_fkey" FOREIGN KEY ("tagID") REFERENCES "FriendTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
