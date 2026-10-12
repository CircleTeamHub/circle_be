CREATE TYPE "NoteWorkStatus" AS ENUM ('WORKING', 'CLOSED');

ALTER TABLE "Note" ADD COLUMN "workStatus" "NoteWorkStatus";
