-- Draft snapshots are deliberately separate from Note rows so incomplete edits
-- do not count toward note quotas or appear in the published note list.
CREATE TABLE "NoteDraft" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "clientDraftID" TEXT NOT NULL,
    "sourceNoteID" TEXT,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT,
    "contentJson" JSONB,
    "sections" JSONB,
    "groupIDs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "mediaKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteDraft_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NoteDraft_ownerID_clientDraftID_key"
  ON "NoteDraft"("ownerID", "clientDraftID");
CREATE INDEX "NoteDraft_ownerID_updatedAt_idx"
  ON "NoteDraft"("ownerID", "updatedAt");
CREATE INDEX "NoteDraft_sourceNoteID_idx"
  ON "NoteDraft"("sourceNoteID");

ALTER TABLE "NoteDraft"
  ADD CONSTRAINT "NoteDraft_ownerID_fkey"
  FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "NoteDraft"
  ADD CONSTRAINT "NoteDraft_sourceNoteID_fkey"
  FOREIGN KEY ("sourceNoteID") REFERENCES "Note"("id") ON DELETE SET NULL ON UPDATE CASCADE;
