BEGIN;

-- User-facing invite codes are uppercase. AccountIdentifier remains the
-- lowercase canonical registry shared by account IDs, invite codes, and fancy
-- numbers so uniqueness stays case-insensitive across all three namespaces.
CREATE OR REPLACE FUNCTION "User_account_identifier_prepare"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  occupied BOOLEAN;
  new_account_identifier TEXT;
  new_invite_identifier TEXT;
  old_account_identifier TEXT;
  old_invite_identifier TEXT;
BEGIN
  NEW."accountId" := lower(NEW."accountId");
  NEW."inviteCode" := upper(NEW."inviteCode");
  new_account_identifier := NEW."accountId";
  new_invite_identifier := lower(NEW."inviteCode");

  IF TG_OP = 'UPDATE' THEN
    old_account_identifier := lower(OLD."accountId");
    old_invite_identifier := lower(OLD."inviteCode");
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(identifier, 0))
  FROM (
    SELECT DISTINCT identifier
    FROM (VALUES (new_account_identifier), (new_invite_identifier)) values_to_lock(identifier)
  ) identifiers_to_lock
  ORDER BY identifier;

  IF TG_OP = 'INSERT' THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AccountIdentifier" ai
      LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
      WHERE ai."value" = new_account_identifier
        AND (
          ai."currentUserID" IS NOT NULL
          OR ai."reservedForUserID" IS NOT NULL
          OR ai."inviteOwnerUserID" IS NOT NULL
          OR fn."id" IS NOT NULL
        )
    ) INTO occupied;
    IF occupied THEN
      RAISE EXCEPTION 'account identifier collision: %', new_account_identifier;
    END IF;

    INSERT INTO "AccountIdentifier" ("value", "createdAt", "updatedAt")
    VALUES (new_account_identifier, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("value") DO NOTHING;

    IF new_invite_identifier <> new_account_identifier THEN
      SELECT EXISTS (
        SELECT 1
        FROM "AccountIdentifier" ai
        LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
        WHERE ai."value" = new_invite_identifier
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
      VALUES (new_invite_identifier, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("value") DO NOTHING;
    END IF;
    RETURN NEW;
  END IF;

  IF new_account_identifier IS DISTINCT FROM old_account_identifier THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AccountIdentifier" ai
      LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
      WHERE ai."value" = new_account_identifier
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
      RAISE EXCEPTION 'account identifier collision: %', new_account_identifier;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM "AccountIdentifier"
      WHERE "value" = new_account_identifier
        AND "currentUserID" = NEW."id"
    ) THEN
      INSERT INTO "AccountIdentifier" ("value", "createdAt", "updatedAt")
      VALUES (new_account_identifier, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("value") DO NOTHING;

      UPDATE "AccountIdentifier"
      SET "currentUserID" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = old_account_identifier
        AND "currentUserID" = NEW."id";

      UPDATE "AccountIdentifier"
      SET "currentUserID" = NEW."id", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = new_account_identifier
        AND "currentUserID" IS NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'account identifier collision: %', new_account_identifier;
      END IF;
    END IF;
  END IF;

  IF new_invite_identifier IS DISTINCT FROM old_invite_identifier THEN
    SELECT EXISTS (
      SELECT 1
      FROM "AccountIdentifier" ai
      LEFT JOIN "FancyNumber" fn ON fn."value" = ai."value"
      WHERE ai."value" = new_invite_identifier
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
      WHERE "value" = new_invite_identifier
        AND "inviteOwnerUserID" = NEW."id"
    ) THEN
      INSERT INTO "AccountIdentifier" ("value", "createdAt", "updatedAt")
      VALUES (new_invite_identifier, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT ("value") DO NOTHING;

      UPDATE "AccountIdentifier"
      SET "inviteOwnerUserID" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = old_invite_identifier
        AND "inviteOwnerUserID" = NEW."id";

      UPDATE "AccountIdentifier"
      SET "inviteOwnerUserID" = NEW."id", "updatedAt" = CURRENT_TIMESTAMP
      WHERE "value" = new_invite_identifier
        AND "inviteOwnerUserID" IS NULL;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'account identifier collision: %', NEW."inviteCode";
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "User_account_identifier_assign"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  invite_identifier TEXT := lower(NEW."inviteCode");
BEGIN
  UPDATE "AccountIdentifier"
  SET
    "currentUserID" = NEW."id",
    "inviteOwnerUserID" = CASE
      WHEN "value" = invite_identifier THEN NEW."id"
      ELSE "inviteOwnerUserID"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "value" = NEW."accountId";

  IF invite_identifier <> NEW."accountId" THEN
    UPDATE "AccountIdentifier"
    SET
      "inviteOwnerUserID" = NEW."id",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "value" = invite_identifier;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "User_account_identifier_cleanup"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_account_identifier TEXT := lower(OLD."accountId");
  new_account_identifier TEXT := lower(NEW."accountId");
  old_invite_identifier TEXT := lower(OLD."inviteCode");
  new_invite_identifier TEXT := lower(NEW."inviteCode");
BEGIN
  IF old_account_identifier IS DISTINCT FROM new_account_identifier THEN
    DELETE FROM "AccountIdentifier" ai
    WHERE ai."value" = old_account_identifier
      AND ai."currentUserID" IS NULL
      AND ai."reservedForUserID" IS NULL
      AND ai."inviteOwnerUserID" IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM "FancyNumber" fn WHERE fn."value" = ai."value"
      );
  END IF;

  IF old_invite_identifier IS DISTINCT FROM new_invite_identifier
    AND old_invite_identifier <> old_account_identifier
  THEN
    DELETE FROM "AccountIdentifier" ai
    WHERE ai."value" = old_invite_identifier
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

UPDATE "User"
SET "inviteCode" = upper("inviteCode")
WHERE "inviteCode" IS DISTINCT FROM upper("inviteCode");

COMMIT;
