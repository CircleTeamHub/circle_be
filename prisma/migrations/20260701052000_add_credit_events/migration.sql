-- CreateTable
CREATE TABLE IF NOT EXISTS "CreditEvent" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "scoreBefore" INTEGER NOT NULL,
    "scoreAfter" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceID" TEXT,
    "actorID" TEXT,
    "idempotencyKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "revertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "CreditEvent_idempotencyKey_key" ON "CreditEvent"("idempotencyKey");
CREATE INDEX IF NOT EXISTS "CreditEvent_userID_createdAt_idx" ON "CreditEvent"("userID", "createdAt");
CREATE INDEX IF NOT EXISTS "CreditEvent_actorID_createdAt_idx" ON "CreditEvent"("actorID", "createdAt");
CREATE INDEX IF NOT EXISTS "CreditEvent_sourceType_sourceID_idx" ON "CreditEvent"("sourceType", "sourceID");

-- AddForeignKey (guarded: Postgres has no ADD CONSTRAINT IF NOT EXISTS)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreditEvent_userID_fkey') THEN
    ALTER TABLE "CreditEvent" ADD CONSTRAINT "CreditEvent_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CreditEvent_actorID_fkey') THEN
    ALTER TABLE "CreditEvent" ADD CONSTRAINT "CreditEvent_actorID_fkey" FOREIGN KEY ("actorID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
