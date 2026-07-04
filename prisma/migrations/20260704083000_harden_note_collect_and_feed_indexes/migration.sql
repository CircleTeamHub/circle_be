-- Follow-up hardening for branch review fixes.
--
-- 1. Concurrent duplicate note collects must converge on one active copy.
--    PostgreSQL allows multiple NULLs in a unique index, and the partial
--    predicate lets a user re-collect after soft-deleting a previous copy.
-- 2. Trace keyset pagination orders by (createdAt DESC, id DESC), so include
--    the id tiebreaker in the supporting index.

DROP INDEX IF EXISTS "Note_ownerID_collectedFromNoteID_idx";

CREATE UNIQUE INDEX IF NOT EXISTS "Note_ownerID_collectedFromNoteID_active_key"
  ON "Note"("ownerID", "collectedFromNoteID")
  WHERE "collectedFromNoteID" IS NOT NULL AND "status" <> 'DELETED';

DROP INDEX IF EXISTS "Trace_fromID_createdAt_idx";

CREATE INDEX IF NOT EXISTS "Trace_fromID_createdAt_id_idx"
  ON "Trace"("fromID", "createdAt" DESC, "id" DESC);
