CREATE TABLE "SessionRevocationOutbox" (
    "userID" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionRevocationOutbox_pkey" PRIMARY KEY ("userID")
);

CREATE INDEX "SessionRevocationOutbox_nextAttemptAt_idx"
ON "SessionRevocationOutbox"("nextAttemptAt");

CREATE INDEX "SessionRevocationOutbox_expiresAt_idx"
ON "SessionRevocationOutbox"("expiresAt");

ALTER TABLE "SessionRevocationOutbox"
ADD CONSTRAINT "SessionRevocationOutbox_userID_fkey"
FOREIGN KEY ("userID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
