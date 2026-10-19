ALTER TABLE "E2eeArchive" ADD COLUMN "cursor" BIGSERIAL NOT NULL;
CREATE UNIQUE INDEX "E2eeArchive_cursor_key" ON "E2eeArchive"("cursor");
DROP INDEX "E2eeArchive_recoveryID_id_idx";
CREATE INDEX "E2eeArchive_recoveryID_cursor_idx" ON "E2eeArchive"("recoveryID", "cursor");
