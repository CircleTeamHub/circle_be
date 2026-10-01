CREATE TYPE "AdminConsoleRole" AS ENUM ('SUPER_ADMIN', 'OPERATIONS', 'MODERATOR', 'SUPPORT');
CREATE TABLE "AdminAccess" (
  "userID" TEXT PRIMARY KEY REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "AdminConsoleRole" NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AdminAccess_role_idx" ON "AdminAccess"("role");
INSERT INTO "AdminAccess" ("userID", "role", "updatedAt")
SELECT "id", 'SUPER_ADMIN'::"AdminConsoleRole", CURRENT_TIMESTAMP FROM "User" WHERE "role" = 'ADMIN' AND "status" = 'ACTIVE';

CREATE TABLE "CampaignInvite" (
  "id" TEXT PRIMARY KEY,
  "code" TEXT UNIQUE NOT NULL,
  "identifierValue" TEXT UNIQUE NOT NULL REFERENCES "AccountIdentifier"("value") ON DELETE RESTRICT ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "ownerUserID" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "maxUses" INTEGER NOT NULL CHECK ("maxUses" BETWEEN 1 AND 100000),
  "usedCount" INTEGER NOT NULL DEFAULT 0 CHECK ("usedCount" >= 0 AND "usedCount" <= "maxUses"),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK ("code" = upper("code") AND "identifierValue" = lower("code"))
);
CREATE INDEX "CampaignInvite_ownerUserID_createdAt_idx" ON "CampaignInvite"("ownerUserID", "createdAt");
CREATE INDEX "CampaignInvite_enabled_expiresAt_idx" ON "CampaignInvite"("enabled", "expiresAt");
CREATE TABLE "CampaignInviteUse" (
  "id" TEXT PRIMARY KEY,
  "campaignID" TEXT NOT NULL REFERENCES "CampaignInvite"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "userID" TEXT UNIQUE NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CampaignInviteUse_campaignID_createdAt_idx" ON "CampaignInviteUse"("campaignID", "createdAt");

-- Campaign codes share the identifier namespace. No account, personal invite or
-- fancy number may claim a code reserved for an operational campaign.
CREATE FUNCTION guard_campaign_identifier_claim() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CampaignInvite" WHERE "identifierValue" = NEW."value")
     AND (NEW."currentUserID" IS NOT NULL OR NEW."reservedForUserID" IS NOT NULL OR NEW."inviteOwnerUserID" IS NOT NULL) THEN
    RAISE EXCEPTION 'Identifier reserved for campaign' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "AccountIdentifier_campaign_guard" BEFORE INSERT OR UPDATE ON "AccountIdentifier"
FOR EACH ROW EXECUTE FUNCTION guard_campaign_identifier_claim();

CREATE FUNCTION guard_campaign_fancy_number() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CampaignInvite" WHERE "identifierValue" = lower(NEW."value")) THEN
    RAISE EXCEPTION 'Identifier reserved for campaign' USING ERRCODE = '23505';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "FancyNumber_campaign_guard" BEFORE INSERT OR UPDATE OF "value" ON "FancyNumber"
FOR EACH ROW EXECUTE FUNCTION guard_campaign_fancy_number();

CREATE TABLE "AdminAdvertisement" (
  "id" TEXT PRIMARY KEY,
  "title" TEXT NOT NULL,
  "imageUrl" TEXT NOT NULL,
  "targetUrl" TEXT NOT NULL,
  "placement" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "startsAt" TIMESTAMP(3) NOT NULL,
  "endsAt" TIMESTAMP(3) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CHECK ("endsAt" > "startsAt"),
  CHECK ("placement" = 'CIRCLE_HOME')
);
CREATE INDEX "AdminAdvertisement_placement_enabled_startsAt_endsAt_idx" ON "AdminAdvertisement"("placement", "enabled", "startsAt", "endsAt");

CREATE TABLE "AdminOperationRequest" (
  "id" TEXT PRIMARY KEY,
  "actorID" TEXT NOT NULL REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "inputHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AdminOperationRequest_actorID_createdAt_idx" ON "AdminOperationRequest"("actorID", "createdAt");
