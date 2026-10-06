-- Persist draft consumption so an autosave that resumes after publication
-- cannot recreate the consumed draft. Existing notes have NULL draft IDs.
ALTER TABLE "Note" ADD COLUMN "clientDraftID" TEXT;
