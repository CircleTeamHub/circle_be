ALTER TABLE "Note" ADD COLUMN "sourceConversationID" TEXT;

CREATE INDEX "Note_sourceConversationID_idx"
  ON "Note"("sourceConversationID");
