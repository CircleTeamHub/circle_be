CREATE TABLE "ChatBurnArchive" (
 "id" TEXT PRIMARY KEY, "conversationID" TEXT NOT NULL, "senderID" TEXT,
 "clientMessageId" TEXT, "height" INTEGER NOT NULL, "type" TEXT NOT NULL,
 "content" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL,
 "burnExpiresAt" TIMESTAMP(3) NOT NULL, "burnDurationSec" INTEGER,
 "retainUntil" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "ChatBurnArchive_conversationID_height_idx" ON "ChatBurnArchive" ("conversationID", "height");
CREATE INDEX "ChatBurnArchive_retainUntil_id_idx" ON "ChatBurnArchive" ("retainUntil", "id");
-- Capture the locked, current content before redaction. No network IO in the transaction.
CREATE FUNCTION archive_burned_chat_message() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT OLD."deleted" AND NEW."deleted" AND OLD."revokedAt" IS NULL
    AND OLD."burnExpiresAt" <= clock_timestamp()
    AND OLD."burnExpiresAt" + INTERVAL '180 days' > clock_timestamp() THEN
  INSERT INTO "ChatBurnArchive" ("id", "conversationID", "senderID", "clientMessageId", "height", "type", "content", "createdAt", "burnExpiresAt", "burnDurationSec", "retainUntil")
  VALUES (OLD."id", OLD."conversationID", OLD."senderID", OLD."clientMessageId", OLD."height", OLD."type", OLD."content", OLD."createdAt", OLD."burnExpiresAt", OLD."burnDurationSec", OLD."burnExpiresAt" + INTERVAL '180 days')
  ON CONFLICT ("id") DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER archive_burned_chat_message BEFORE UPDATE OF "deleted" ON "ChatMessage"
 FOR EACH ROW EXECUTE FUNCTION archive_burned_chat_message();
-- User recovery copies still disappear; authorized audit copies follow the archive TTL.
CREATE OR REPLACE FUNCTION purge_e2ee_message_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."deleted" OR NEW."revokedAt" IS NOT NULL THEN
  DELETE FROM "E2eeArchive" a USING "E2eeRecovery" r
  WHERE a."messageID"=NEW."id" AND a."recoveryID"=r."id"
    AND (r."purpose" <> 'AUDIT' OR NOT EXISTS (
      SELECT 1 FROM "ChatBurnArchive" retained WHERE retained."id"=NEW."id" AND retained."retainUntil">clock_timestamp()
    ));
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION purge_e2ee_cleared_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'ChatMember' THEN
  DELETE FROM "E2eeArchive" a USING "ChatMessage" m, "E2eeRecovery" r
  WHERE a."messageID"=m."id" AND a."recoveryID"=r."id" AND r."purpose"='APP'
   AND r."userID"=NEW."userID" AND m."conversationID"=NEW."conversationID"
   AND (NEW."leftAt" IS NOT NULL OR m."height"<=NEW."clearedBeforeHeight");
 ELSE
  DELETE FROM "E2eeArchive" a USING "ChatMessage" m, "E2eeRecovery" r
  WHERE a."messageID"=m."id" AND a."recoveryID"=r."id"
   AND m."conversationID"=NEW."id" AND m."height"<=NEW."clearedBeforeHeight"
   AND (r."purpose" <> 'AUDIT' OR (NOT (
     COALESCE(m."burnDurationSec", 0) > 0 AND NOT m."deleted" AND m."revokedAt" IS NULL
     AND (m."burnExpiresAt" IS NULL OR m."burnExpiresAt" + INTERVAL '180 days' > clock_timestamp())
   ) AND NOT EXISTS (
     SELECT 1 FROM "ChatBurnArchive" retained WHERE retained."id"=m."id" AND retained."retainUntil">clock_timestamp()
   )));
 END IF;
 RETURN NEW;
END $$;
