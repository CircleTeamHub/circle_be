-- Keep the two potentially large production indexes outside the schema-change
-- migration so PostgreSQL can build them without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Note_rootSourceNoteID_id_idx"
  ON "Note" ("rootSourceNoteID", "id");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ChatMessage_live_note_source_conversation_idx"
  ON "ChatMessage" ("sourceNoteID", "conversationID")
  WHERE "type" = 'note-card'
    AND "deleted" = false
    AND "revokedAt" IS NULL
    AND "sourceNoteID" IS NOT NULL;
