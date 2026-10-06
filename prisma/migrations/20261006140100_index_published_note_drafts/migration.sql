-- Keep concurrent DDL in its own migration: Prisma sends a script in one call.
CREATE UNIQUE INDEX CONCURRENTLY "Note_ownerID_clientDraftID_key"
ON "Note"("ownerID", "clientDraftID");
