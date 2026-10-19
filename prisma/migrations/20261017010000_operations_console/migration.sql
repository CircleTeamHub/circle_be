CREATE TABLE "ConsoleEvent" ("id" TEXT PRIMARY KEY, "userID" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "source" TEXT NOT NULL DEFAULT 'SERVER', "entityType" TEXT, "entityID" TEXT, "platform" TEXT, "appVersion" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX "ConsoleEvent_userID_createdAt_id_idx" ON "ConsoleEvent"("userID", "createdAt", "id");
CREATE INDEX "ConsoleEvent_name_createdAt_idx" ON "ConsoleEvent"("name", "createdAt");
CREATE INDEX "ConsoleEvent_createdAt_idx" ON "ConsoleEvent"("createdAt");
CREATE TABLE "AppInstallation" ("id" TEXT PRIMARY KEY, "userID" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "deviceKey" TEXT NOT NULL, "platform" TEXT NOT NULL, "appVersion" TEXT NOT NULL, "build" INTEGER NOT NULL, "channel" TEXT NOT NULL DEFAULT 'stable', "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "AppInstallation_userID_deviceKey_key" ON "AppInstallation"("userID", "deviceKey");
CREATE INDEX "AppInstallation_platform_channel_build_idx" ON "AppInstallation"("platform", "channel", "build");
CREATE TABLE "ConsoleApiKey" ("id" TEXT PRIMARY KEY, "userID" TEXT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE, "name" TEXT NOT NULL, "prefix" TEXT NOT NULL, "secretHash" TEXT NOT NULL, "scopes" TEXT[] NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "lastUsedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "ConsoleApiKey_secretHash_key" ON "ConsoleApiKey"("secretHash");
CREATE INDEX "ConsoleApiKey_userID_createdAt_idx" ON "ConsoleApiKey"("userID", "createdAt");
CREATE TABLE "ConsoleRelease" ("id" TEXT PRIMARY KEY, "platform" TEXT NOT NULL, "channel" TEXT NOT NULL, "version" TEXT NOT NULL, "build" INTEGER NOT NULL, "url" TEXT NOT NULL, "sha256" TEXT NOT NULL, "sizeBytes" INTEGER NOT NULL, "notes" TEXT NOT NULL, "withdrawnAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE UNIQUE INDEX "ConsoleRelease_platform_channel_build_key" ON "ConsoleRelease"("platform", "channel", "build");
CREATE TABLE "ConsoleReleasePlan" ("id" TEXT PRIMARY KEY, "releaseID" TEXT NOT NULL REFERENCES "ConsoleRelease"("id") ON DELETE RESTRICT, "rollout" INTEGER NOT NULL CHECK ("rollout" BETWEEN 0 AND 100), "minBuild" INTEGER NOT NULL, "maxBuild" INTEGER NOT NULL, "forceBelow" INTEGER NOT NULL, "startsAt" TIMESTAMP(3) NOT NULL, "endsAt" TIMESTAMP(3) NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT TRUE, "version" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK ("minBuild" <= "maxBuild" AND "startsAt" < "endsAt"));
CREATE INDEX "ConsoleReleasePlan_enabled_startsAt_endsAt_idx" ON "ConsoleReleasePlan"("enabled", "startsAt", "endsAt");
CREATE TABLE "ConsolePushSettings" ("id" TEXT PRIMARY KEY DEFAULT 'global', "enabled" BOOLEAN NOT NULL DEFAULT TRUE, "version" INTEGER NOT NULL DEFAULT 1, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP);
INSERT INTO "ConsolePushSettings" ("id") VALUES ('global');

-- Only event identity and outcome, never message/note bodies or credentials.
CREATE FUNCTION circle_console_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor TEXT;
BEGIN
  actor := to_jsonb(NEW)->>TG_ARGV[0];
  IF actor IS NOT NULL THEN
    INSERT INTO "ConsoleEvent" ("id","userID","name","entityType","entityID")
    VALUES (gen_random_uuid()::text, actor, TG_ARGV[1], TG_TABLE_NAME, to_jsonb(NEW)->>'id');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER console_message AFTER INSERT ON "ChatMessage" FOR EACH ROW WHEN (NEW."senderID" IS NOT NULL) EXECUTE FUNCTION circle_console_event('senderID','MESSAGE_SENT');
CREATE TRIGGER console_note AFTER INSERT ON "Note" FOR EACH ROW EXECUTE FUNCTION circle_console_event('ownerID','NOTE_CREATED');
CREATE TRIGGER console_circle_member AFTER INSERT ON "CircleMember" FOR EACH ROW WHEN (NEW.status = 'ACTIVE') EXECUTE FUNCTION circle_console_event('userID','GROUP_JOINED');
CREATE TRIGGER console_circle_member_approved AFTER UPDATE OF status ON "CircleMember" FOR EACH ROW WHEN (NEW.status = 'ACTIVE' AND OLD.status <> 'ACTIVE') EXECUTE FUNCTION circle_console_event('userID','GROUP_JOINED');
CREATE TRIGGER console_trace AFTER INSERT ON "Trace" FOR EACH ROW EXECUTE FUNCTION circle_console_event('fromID','POST_CREATED');
CREATE TRIGGER console_registration AFTER INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION circle_console_event('id','REGISTERED');
