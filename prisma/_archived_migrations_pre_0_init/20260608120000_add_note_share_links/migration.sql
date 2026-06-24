-- CreateTable
CREATE TABLE "NoteShareLink" (
  "id" TEXT NOT NULL,
  "ownerID" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" "NoteStatus",
  "group" TEXT,
  "groupID" TEXT,
  "search" TEXT,
  "noteIDs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NoteShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NoteShareLink_token_key" ON "NoteShareLink"("token");

-- CreateIndex
CREATE INDEX "NoteShareLink_ownerID_createdAt_idx" ON "NoteShareLink"("ownerID", "createdAt");

-- CreateIndex
CREATE INDEX "NoteShareLink_token_idx" ON "NoteShareLink"("token");

-- CreateIndex
CREATE INDEX "NoteShareLink_expiresAt_idx" ON "NoteShareLink"("expiresAt");

-- AddForeignKey
ALTER TABLE "NoteShareLink"
ADD CONSTRAINT "NoteShareLink_ownerID_fkey"
FOREIGN KEY ("ownerID") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
