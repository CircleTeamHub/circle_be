-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('ACTIVE', 'UNLISTED', 'DELETED');

-- CreateEnum
CREATE TYPE "NoteMediaType" AS ENUM ('IMAGE', 'VIDEO');

-- CreateTable
CREATE TABLE "NoteGroup" (
  "id" TEXT NOT NULL,
  "ownerID" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NoteGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
  "id" TEXT NOT NULL,
  "ownerID" TEXT NOT NULL,
  "groupID" TEXT,
  "title" TEXT NOT NULL,
  "content" TEXT,
  "status" "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
  "pinned" BOOLEAN NOT NULL DEFAULT false,
  "coverMediaID" TEXT,
  "mediaCount" INTEGER NOT NULL DEFAULT 0,
  "imageCount" INTEGER NOT NULL DEFAULT 0,
  "videoCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteMedia" (
  "id" TEXT NOT NULL,
  "noteID" TEXT NOT NULL,
  "type" "NoteMediaType" NOT NULL,
  "objectKey" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mimeType" TEXT,
  "size" INTEGER,
  "width" INTEGER,
  "height" INTEGER,
  "durationMs" INTEGER,
  "posterUrl" TEXT,
  "sortOrder" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NoteMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NoteGroup_ownerID_deletedAt_sortOrder_idx" ON "NoteGroup"("ownerID", "deletedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "Note_ownerID_status_updatedAt_idx" ON "Note"("ownerID", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Note_ownerID_pinned_updatedAt_idx" ON "Note"("ownerID", "pinned", "updatedAt");

-- CreateIndex
CREATE INDEX "Note_groupID_idx" ON "Note"("groupID");

-- CreateIndex
CREATE UNIQUE INDEX "Note_coverMediaID_key" ON "Note"("coverMediaID");

-- CreateIndex
CREATE UNIQUE INDEX "NoteMedia_noteID_sortOrder_key" ON "NoteMedia"("noteID", "sortOrder");

-- CreateIndex
CREATE INDEX "NoteMedia_noteID_sortOrder_idx" ON "NoteMedia"("noteID", "sortOrder");

-- AddForeignKey
ALTER TABLE "NoteGroup"
ADD CONSTRAINT "NoteGroup_ownerID_fkey"
FOREIGN KEY ("ownerID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note"
ADD CONSTRAINT "Note_ownerID_fkey"
FOREIGN KEY ("ownerID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note"
ADD CONSTRAINT "Note_groupID_fkey"
FOREIGN KEY ("groupID") REFERENCES "NoteGroup"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteMedia"
ADD CONSTRAINT "NoteMedia_noteID_fkey"
FOREIGN KEY ("noteID") REFERENCES "Note"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note"
ADD CONSTRAINT "Note_coverMediaID_fkey"
FOREIGN KEY ("coverMediaID") REFERENCES "NoteMedia"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
