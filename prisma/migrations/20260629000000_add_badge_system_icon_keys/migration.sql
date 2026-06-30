ALTER TYPE "SystemIconKey" ADD VALUE IF NOT EXISTS 'TOP_COLLABORATOR';
ALTER TYPE "SystemIconKey" ADD VALUE IF NOT EXISTS 'VERIFIED_PROFILE';
ALTER TYPE "SystemIconKey" ADD VALUE IF NOT EXISTS 'CIRCLE_BUILDER';

ALTER TABLE "CirclePost"
ADD COLUMN IF NOT EXISTS "collaborationRecognizedAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "CollaborationRecognition" (
  "id" TEXT NOT NULL,
  "recipientID" TEXT NOT NULL,
  "recognizerID" TEXT NOT NULL,
  "circlePostID" TEXT,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CollaborationRecognition_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CollaborationRecognition_recipientID_revokedAt_idx"
ON "CollaborationRecognition"("recipientID", "revokedAt");

CREATE INDEX IF NOT EXISTS "CollaborationRecognition_recognizerID_createdAt_idx"
ON "CollaborationRecognition"("recognizerID", "createdAt");

CREATE INDEX IF NOT EXISTS "CollaborationRecognition_circlePostID_idx"
ON "CollaborationRecognition"("circlePostID");

-- At most one recognition per (post, recipient). NULL circlePostID rows are not
-- constrained by Postgres multi-column unique semantics, which is fine: every
-- recognition is created with a circlePostID.
CREATE UNIQUE INDEX IF NOT EXISTS "CollaborationRecognition_circlePostID_recipientID_key"
ON "CollaborationRecognition"("circlePostID", "recipientID");

-- AddForeignKey
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`, so guard each FK so the
-- existing-DB baseline-reset runbook (db push → resolve 0_init → migrate
-- deploy) re-applies cleanly when the constraints already exist.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CollaborationRecognition_recipientID_fkey') THEN
    ALTER TABLE "CollaborationRecognition" ADD CONSTRAINT "CollaborationRecognition_recipientID_fkey" FOREIGN KEY ("recipientID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CollaborationRecognition_recognizerID_fkey') THEN
    ALTER TABLE "CollaborationRecognition" ADD CONSTRAINT "CollaborationRecognition_recognizerID_fkey" FOREIGN KEY ("recognizerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CollaborationRecognition_circlePostID_fkey') THEN
    ALTER TABLE "CollaborationRecognition" ADD CONSTRAINT "CollaborationRecognition_circlePostID_fkey" FOREIGN KEY ("circlePostID") REFERENCES "CirclePost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
