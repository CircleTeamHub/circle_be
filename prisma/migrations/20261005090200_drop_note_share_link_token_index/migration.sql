-- NoteShareLink_token_key is the unique index for token; the plain token
-- index is an exact duplicate.
DROP INDEX CONCURRENTLY IF EXISTS "NoteShareLink_token_idx";
