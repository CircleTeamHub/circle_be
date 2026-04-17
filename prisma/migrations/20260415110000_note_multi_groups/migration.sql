-- CreateTable
CREATE TABLE "NoteGroupMembership" (
  "id" TEXT NOT NULL,
  "noteID" TEXT NOT NULL,
  "groupID" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NoteGroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NoteGroupMembership_noteID_groupID_key" ON "NoteGroupMembership"("noteID", "groupID");

-- CreateIndex
CREATE INDEX "NoteGroupMembership_groupID_idx" ON "NoteGroupMembership"("groupID");

-- AddForeignKey
ALTER TABLE "NoteGroupMembership"
ADD CONSTRAINT "NoteGroupMembership_noteID_fkey"
FOREIGN KEY ("noteID") REFERENCES "Note"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteGroupMembership"
ADD CONSTRAINT "NoteGroupMembership_groupID_fkey"
FOREIGN KEY ("groupID") REFERENCES "NoteGroup"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing single-group notes into membership rows
INSERT INTO "NoteGroupMembership" ("id", "noteID", "groupID", "createdAt")
SELECT
  'note-group-membership-' || "id",
  "id",
  "groupID",
  CURRENT_TIMESTAMP
FROM "Note"
WHERE "groupID" IS NOT NULL
ON CONFLICT ("noteID", "groupID") DO NOTHING;
