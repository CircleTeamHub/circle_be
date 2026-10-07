-- Rich note composer support: audio attachments and structured contact/group cards.
-- Contact and group-card snapshots are stored in Note.sections JSON so they remain
-- immutable snapshots and do not expose live roster data to note readers.
ALTER TYPE "NoteMediaType" ADD VALUE IF NOT EXISTS 'AUDIO';

ALTER TABLE "Note" ADD COLUMN "audioCount" INTEGER NOT NULL DEFAULT 0;
