-- Denormalize the stable root of each collect chain. Keep the id even if the
-- root has already been purged; no foreign key is intentional.
ALTER TABLE "Note" ADD COLUMN "rootSourceNoteID" TEXT;

WITH RECURSIVE ancestry AS (
  SELECT
    note."id" AS "descendantID",
    note."collectedFromNoteID" AS "ancestorID",
    note."collectedFromNoteID" AS "rootID",
    1 AS depth,
    ARRAY[note."id"]::TEXT[] AS path
  FROM "Note" AS note
  WHERE note."collectedFromNoteID" IS NOT NULL

  UNION ALL

  SELECT
    ancestry."descendantID",
    parent."collectedFromNoteID" AS "ancestorID",
    parent."id" AS "rootID",
    ancestry.depth + 1,
    ancestry.path || parent."id"
  FROM ancestry
  JOIN "Note" AS parent ON parent."id" = ancestry."ancestorID"
  WHERE ancestry.depth < 64
    AND NOT parent."id" = ANY(ancestry.path)
), resolved AS (
  SELECT DISTINCT ON ("descendantID")
    "descendantID",
    "rootID"
  FROM ancestry
  ORDER BY "descendantID", depth DESC
)
UPDATE "Note" AS note
SET "rootSourceNoteID" = resolved."rootID"
FROM resolved
WHERE note."id" = resolved."descendantID";

-- Persist server-resolved note-card provenance so fan-out never has to scan
-- arbitrary JSON paths. Existing rows prefer sourceNoteId, then resolve the
-- legacy noteId through the denormalized Note root.
ALTER TABLE "ChatMessage" ADD COLUMN "sourceNoteID" TEXT;

UPDATE "ChatMessage" AS message
SET "sourceNoteID" = COALESCE(
  NULLIF(message."content"->>'sourceNoteId', ''),
  (
    SELECT COALESCE(note."rootSourceNoteID", note."id")
    FROM "Note" AS note
    WHERE note."id" = NULLIF(message."content"->>'noteId', '')
  ),
  NULLIF(message."content"->>'noteId', '')
)
WHERE message."type" = 'note-card';

CREATE TYPE "NoteStatusFanoutOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'FAILED');
CREATE TYPE "NoteStatusFanoutStage" AS ENUM ('OWNERS', 'CHAT_MEMBERS');

CREATE TABLE "NoteStatusFanoutOutbox" (
  "rootNoteID" TEXT NOT NULL,
  "status" "NoteStatusFanoutOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "stage" "NoteStatusFanoutStage" NOT NULL DEFAULT 'OWNERS',
  "generation" INTEGER NOT NULL DEFAULT 1,
  "noteCursor" TEXT,
  "chatConversationCursor" TEXT,
  "chatUserCursor" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "leaseToken" TEXT,
  "lastError" VARCHAR(1000),
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "NoteStatusFanoutOutbox_pkey" PRIMARY KEY ("rootNoteID")
);

CREATE INDEX "NoteStatusFanoutOutbox_status_nextAttemptAt_queuedAt_idx"
  ON "NoteStatusFanoutOutbox" ("status", "nextAttemptAt", "queuedAt");
