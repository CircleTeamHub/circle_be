BEGIN;

-- Reinstall the trigger functions for databases that already applied the
-- original marketplace migration before cleanup moved out of the BEFORE
-- trigger. Keeping this as a forward migration makes the fix upgrade-safe.
CREATE OR REPLACE FUNCTION "User_account_identifier_prepare"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  occupied BOOLEAN;
BEGIN
  NEW."accountId" := lower(NEW."accountId");
  NEW."inviteCode" := lower(NEW."inviteCode");

  PERFORM pg_advisory_xact_lock(hashtextextended(identifier, 0))
  FROM (
    SELECT DISTINCT identifier
    FROM (VALUES (NEW."accountId"), (NEW."inviteCode")) values_to_lock(identifier)
  ) identifiers_to_lock
  ORDER BY identifier;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AccountIdentifier" ai
      LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
      WHERE ai."value" = NEW."accountId"
        AND (
          ai."currentUserID" IS NOT NULL
          OR ai."reservedForUserID" IS NOT NULL
          OR ai."inviteOwnerUserID" IS NOT NULL
          OR fn."id" IS NOT NULL
        )
    ) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION 'account identifier collision: %', NEW."accountId";
    END IF;

    INSERT INTO "AccountIdentifier" ("value", "createdAt", "updatedAt")
    VALUES (NEW."accountId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("value") DO NOTHING;

    IF NEW."inviteCode" <> NEW."accountId" THEN
      SELECT EXISTS (
        SELECT 1
        FROM "AccountIdentifier" ai
        LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
        WHERE ai."value" = NEW."inviteCode"
          AND (
            ai."currentUserID" IS NOT NULL
            OR ai."reservedForUserID" IS NOT NULL
            OR ai."inviteOwnerUserID" IS NOT NULL
            OR fn."id" IS NOT NULL
          )
      ) INTO occupied;
      IF occupied THEN
        RAISE EXCEPTION 'account identifier collision: %', NEW."inviteCode";
      END IF;
      INSERT INTO "AccountIdentifier" ("value", "createdAt", "updatedAt")
      VALUES (NEW."inviteCode", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("value") DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."accountId" IS DISTINCT FROM OLD."accountId" THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AccountIdentifier" ai
      LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
      WHERE ai."value" = NEW."accountId"
        AND ai."currentUserID" IS DISTINCT FROM NEW."id"
        AND (
          ai."currentUserID" IS NOT NULL
          OR ai."reservedForUserID" IS NOT NULL
          OR (
            ai."inviteOwnerUserID" IS NOT NULL
            AND ai."inviteOwnerUserID" <> NEW."id"
          )
          OR fn."id" IS NOT NULL
        )
    ) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION 'account identifier collision: %', NEW."accountId";
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM "AccountIdentifier"
      WHERE "value" = NEW."accountId"
        AND "currentUserID" = NEW."id"
    ) THEN
      INSERT INTO "AccountIdentifier" ("value", "createdAt", "updatedAt")
      VALUES (NEW."accountId", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("value") DO NOTHING;

      UPDATE "AccountIdentifier"
      SET "currentUserID" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = OLD."accountId"
        AND "currentUserID" = NEW."id";

      UPDATE "AccountIdentifier"
      SET "currentUserID" = NEW."id", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = NEW."accountId"
        AND "currentUserID" IS NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'account identifier collision: %', NEW."accountId";
      END IF;
    END IF;
  END IF;

  IF NEW."inviteCode" IS DISTINCT FROM OLD."inviteCode" THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AccountIdentifier" ai
      LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
      WHERE ai."value" = NEW."inviteCode"
        AND (
          (
            ai."currentUserID" IS NOT NULL
            AND ai."currentUserID" <> NEW."id"
          )
          OR ai."reservedForUserID" IS NOT NULL
          OR (
            ai."inviteOwnerUserID" IS NOT NULL
            AND ai."inviteOwnerUserID" <> NEW."id"
          )
          OR fn."id" IS NOT NULL
        )
    ) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION 'account identifier collision: %', NEW."inviteCode";
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM "AccountIdentifier"
      WHERE "value" = NEW."inviteCode"
        AND "inviteOwnerUserID" = NEW."id"
    ) THEN
      INSERT INTO "AccountIdentifier" ("value", "createdAt", "updatedAt")
      VALUES (NEW."inviteCode", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("value") DO NOTHING;

      UPDATE "AccountIdentifier"
      SET "inviteOwnerUserID" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = OLD."inviteCode"
        AND "inviteOwnerUserID" = NEW."id";

      UPDATE "AccountIdentifier"
      SET "inviteOwnerUserID" = NEW."id", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = NEW."inviteCode"
        AND "inviteOwnerUserID" IS NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'account identifier collision: %', NEW."inviteCode";
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "User_account_identifier_cleanup"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."accountId" IS DISTINCT FROM NEW."accountId" THEN
    DELETE FROM "AccountIdentifier" ai
    WHERE ai."value" = OLD."accountId"
      AND ai."currentUserID" IS NULL
      AND ai."reservedForUserID" IS NULL
      AND ai."inviteOwnerUserID" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "FancyNumber" fn WHERE fn."value" = ai."value"
      );
  END IF;

  IF OLD."inviteCode" IS DISTINCT FROM NEW."inviteCode"
    AND OLD."inviteCode" <> OLD."accountId"
  THEN
    DELETE FROM "AccountIdentifier" ai
    WHERE ai."value" = OLD."inviteCode"
      AND ai."currentUserID" IS NULL
      AND ai."reservedForUserID" IS NULL
      AND ai."inviteOwnerUserID" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "FancyNumber" fn WHERE fn."value" = ai."value"
      );
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "User_account_identifier_cleanup_trigger" ON "User";
CREATE TRIGGER "User_account_identifier_cleanup_trigger"
AFTER UPDATE OF "accountId", "inviteCode" ON "User"
FOR EACH ROW EXECUTE FUNCTION "User_account_identifier_cleanup"();

COMMIT;
