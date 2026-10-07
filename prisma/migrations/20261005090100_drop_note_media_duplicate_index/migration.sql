-- NoteMedia_noteID_sortOrder_key already covers this exact lookup and
-- enforces uniqueness; the plain duplicate index only adds write overhead.
DROP INDEX CONCURRENTLY IF EXISTS "NoteMedia_noteID_sortOrder_idx";
