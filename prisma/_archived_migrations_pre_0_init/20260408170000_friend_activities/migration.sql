ALTER TYPE "FriendState" ADD VALUE 'WITHDRAWN';

CREATE TYPE "FriendActivityType" AS ENUM (
  'REQUEST_RECEIVED',
  'REQUEST_SENT',
  'REQUEST_ACCEPTED_BY_OTHER',
  'REQUEST_REJECTED_BY_OTHER',
  'REQUEST_ACCEPTED_BY_ME',
  'REQUEST_REJECTED_BY_ME',
  'REQUEST_WITHDRAWN_BY_OTHER'
);

CREATE TABLE "FriendActivity" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "viewerId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "counterpartyId" TEXT NOT NULL,
  "type" "FriendActivityType" NOT NULL,
  "messageSnapshot" TEXT,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FriendActivity_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "FriendActivity_requestId_idx" ON "FriendActivity"("requestId");
CREATE INDEX "FriendActivity_viewerId_createdAt_idx" ON "FriendActivity"("viewerId", "createdAt");
CREATE INDEX "FriendActivity_viewerId_readAt_idx" ON "FriendActivity"("viewerId", "readAt");

ALTER TABLE "FriendActivity"
ADD CONSTRAINT "FriendActivity_requestId_fkey"
FOREIGN KEY ("requestId") REFERENCES "Friend"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FriendActivity"
ADD CONSTRAINT "FriendActivity_viewerId_fkey"
FOREIGN KEY ("viewerId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FriendActivity"
ADD CONSTRAINT "FriendActivity_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "FriendActivity"
ADD CONSTRAINT "FriendActivity_counterpartyId_fkey"
FOREIGN KEY ("counterpartyId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
