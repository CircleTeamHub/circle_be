CREATE TABLE "E2eeRecovery" (
 "id" TEXT PRIMARY KEY, "userID" TEXT NOT NULL, "purpose" TEXT NOT NULL,
 "publicKey" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "E2eeRecovery_userID_purpose_key" UNIQUE ("userID", "purpose")
);
CREATE TABLE "E2eeArchive" (
 "id" TEXT PRIMARY KEY, "recoveryID" TEXT NOT NULL REFERENCES "E2eeRecovery"("id") ON DELETE CASCADE,
 "messageID" TEXT NOT NULL REFERENCES "ChatMessage"("id") ON DELETE CASCADE, "ciphertext" TEXT NOT NULL,
 CONSTRAINT "E2eeArchive_recoveryID_messageID_key" UNIQUE ("recoveryID", "messageID")
);
CREATE INDEX "E2eeArchive_recoveryID_id_idx" ON "E2eeArchive"("recoveryID", "id");
CREATE INDEX "E2eeArchive_messageID_idx" ON "E2eeArchive"("messageID");
CREATE FUNCTION purge_e2ee_message_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."deleted" OR NEW."revokedAt" IS NOT NULL THEN
  DELETE FROM "E2eeArchive" WHERE "messageID" = NEW."id";
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER e2ee_message_retention AFTER UPDATE OF "deleted", "revokedAt" ON "ChatMessage"
 FOR EACH ROW EXECUTE FUNCTION purge_e2ee_message_archive();
CREATE FUNCTION purge_e2ee_cleared_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME = 'ChatMember' THEN
  DELETE FROM "E2eeArchive" a USING "ChatMessage" m, "E2eeRecovery" r
  WHERE a."messageID"=m."id" AND a."recoveryID"=r."id" AND r."purpose"='APP'
   AND r."userID"=NEW."userID" AND m."conversationID"=NEW."conversationID"
   AND (NEW."leftAt" IS NOT NULL OR m."height"<=NEW."clearedBeforeHeight");
 ELSE
  DELETE FROM "E2eeArchive" a USING "ChatMessage" m
  WHERE a."messageID"=m."id" AND m."conversationID"=NEW."id" AND m."height"<=NEW."clearedBeforeHeight";
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER e2ee_member_retention AFTER UPDATE OF "clearedBeforeHeight", "leftAt" ON "ChatMember"
 FOR EACH ROW EXECUTE FUNCTION purge_e2ee_cleared_archive();
CREATE TRIGGER e2ee_conversation_retention AFTER UPDATE OF "clearedBeforeHeight" ON "ChatConversation"
 FOR EACH ROW EXECUTE FUNCTION purge_e2ee_cleared_archive();
