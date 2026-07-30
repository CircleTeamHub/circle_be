BEGIN;

-- Fail with a useful value before any registry write can hit a primary-key
-- conflict. accountId and inviteCode share one case-insensitive namespace.
DO $$
DECLARE
  collision_value TEXT;
BEGIN
  SELECT normalized
  INTO collision_value
  FROM (
    SELECT lower("accountId") AS normalized, "id" AS owner_id FROM "User"
    UNION ALL
    SELECT lower("inviteCode") AS normalized, "id" AS owner_id FROM "User"
  ) identifiers
  GROUP BY normalized
  HAVING count(DISTINCT owner_id) > 1
  LIMIT 1;

  IF collision_value IS NOT NULL THEN
    RAISE EXCEPTION 'account identifier collision: %', collision_value;
  END IF;
END
$$;

UPDATE "User"
SET
  "accountId" = lower("accountId"),
  "inviteCode" = lower("inviteCode")
WHERE
  "accountId" IS DISTINCT FROM lower("accountId")
  OR "inviteCode" IS DISTINCT FROM lower("inviteCode");

CREATE TYPE "FancyNumberStatus" AS ENUM (
  'AVAILABLE',
  'LEASED',
  'PERMANENT',
  'DISABLED'
);

CREATE TYPE "FancyNumberSource" AS ENUM (
  'ADMIN',
  'LEGACY'
);

CREATE TYPE "FancyNumberLeaseEndReason" AS ENUM ('EXPIRED');

CREATE TYPE "FancyNumberOrderType" AS ENUM (
  'PURCHASE',
  'RENEWAL',
  'SUPER_CONVERSION',
  'LEGACY_GRANT'
);

ALTER TABLE "User"
  ADD COLUMN "fancyNumberExpiresAt" TIMESTAMP(3),
  ADD COLUMN "fancyNumberPermanent" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AccountIdentifier" (
  "value" TEXT NOT NULL,
  "currentUserID" TEXT,
  "reservedForUserID" TEXT,
  "inviteOwnerUserID" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AccountIdentifier_pkey" PRIMARY KEY ("value"),
  CONSTRAINT "AccountIdentifier_value_lower_check"
    CHECK ("value" = lower("value"))
);

CREATE UNIQUE INDEX "AccountIdentifier_currentUserID_key"
  ON "AccountIdentifier"("currentUserID");
CREATE UNIQUE INDEX "AccountIdentifier_reservedForUserID_key"
  ON "AccountIdentifier"("reservedForUserID");
CREATE UNIQUE INDEX "AccountIdentifier_inviteOwnerUserID_key"
  ON "AccountIdentifier"("inviteOwnerUserID");

CREATE OR REPLACE FUNCTION "AccountIdentifier_lock_value"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."value" := lower(NEW."value");
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."value", 0));
  RETURN NEW;
END
$$;

CREATE TRIGGER "AccountIdentifier_lock_value_trigger"
BEFORE INSERT OR UPDATE OF "value" ON "AccountIdentifier"
FOR EACH ROW EXECUTE FUNCTION "AccountIdentifier_lock_value"();

CREATE TABLE "FancyNumber" (
  "id" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "status" "FancyNumberStatus" NOT NULL DEFAULT 'AVAILABLE',
  "source" "FancyNumberSource" NOT NULL DEFAULT 'ADMIN',
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdByUserID" TEXT,
  "disabledAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FancyNumber_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FancyNumber_value_lower_check" CHECK ("value" = lower("value"))
);

CREATE UNIQUE INDEX "FancyNumber_value_key" ON "FancyNumber"("value");
CREATE INDEX "FancyNumber_status_sortOrder_id_idx"
  ON "FancyNumber"("status", "sortOrder", "id");

CREATE TABLE "FancyNumberLease" (
  "id" TEXT NOT NULL,
  "userID" TEXT NOT NULL,
  "fancyNumberID" TEXT NOT NULL,
  "restoreAccountId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3),
  "permanentAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "endReason" "FancyNumberLeaseEndReason",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "FancyNumberLease_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FancyNumberLease_duration_check" CHECK (
    ("expiresAt" IS NOT NULL AND "permanentAt" IS NULL)
    OR ("expiresAt" IS NULL AND "permanentAt" IS NOT NULL)
  ),
  CONSTRAINT "FancyNumberLease_end_reason_check" CHECK (
    ("endedAt" IS NULL AND "endReason" IS NULL)
    OR ("endedAt" IS NOT NULL AND "endReason" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "FancyNumberLease_active_user_key"
  ON "FancyNumberLease"("userID")
  WHERE "endedAt" IS NULL;
CREATE UNIQUE INDEX "FancyNumberLease_active_number_key"
  ON "FancyNumberLease"("fancyNumberID")
  WHERE "endedAt" IS NULL;
CREATE INDEX "FancyNumberLease_userID_createdAt_idx"
  ON "FancyNumberLease"("userID", "createdAt");
CREATE INDEX "FancyNumberLease_fancyNumberID_createdAt_idx"
  ON "FancyNumberLease"("fancyNumberID", "createdAt");
CREATE INDEX "FancyNumberLease_endedAt_expiresAt_idx"
  ON "FancyNumberLease"("endedAt", "expiresAt");

CREATE TABLE "FancyNumberOrder" (
  "id" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestFingerprint" TEXT NOT NULL,
  "type" "FancyNumberOrderType" NOT NULL,
  "userID" TEXT NOT NULL,
  "fancyNumberID" TEXT NOT NULL,
  "leaseID" TEXT NOT NULL,
  "months" INTEGER,
  "unitPrice" INTEGER NOT NULL,
  "totalPrice" INTEGER NOT NULL,
  "walletBalanceAfter" INTEGER,
  "previousExpiresAt" TIMESTAMP(3),
  "newExpiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "FancyNumberOrder_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FancyNumberOrder_months_check"
    CHECK ("months" IS NULL OR "months" BETWEEN 1 AND 12),
  CONSTRAINT "FancyNumberOrder_prices_check"
    CHECK ("unitPrice" >= 0 AND "totalPrice" >= 0)
);

CREATE UNIQUE INDEX "FancyNumberOrder_idempotencyKey_key"
  ON "FancyNumberOrder"("idempotencyKey");
CREATE INDEX "FancyNumberOrder_userID_createdAt_idx"
  ON "FancyNumberOrder"("userID", "createdAt");
CREATE INDEX "FancyNumberOrder_fancyNumberID_createdAt_idx"
  ON "FancyNumberOrder"("fancyNumberID", "createdAt");
CREATE INDEX "FancyNumberOrder_leaseID_createdAt_idx"
  ON "FancyNumberOrder"("leaseID", "createdAt");

INSERT INTO "AccountIdentifier" (
  "value",
  "currentUserID",
  "createdAt",
  "updatedAt"
)
SELECT lower("accountId"), "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User";

INSERT INTO "AccountIdentifier" (
  "value",
  "inviteOwnerUserID",
  "createdAt",
  "updatedAt"
)
SELECT lower("inviteCode"), "id", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "User"
ON CONFLICT ("value") DO UPDATE
SET
  "inviteOwnerUserID" = EXCLUDED."inviteOwnerUserID",
  "updatedAt" = CURRENT_TIMESTAMP;

INSERT INTO "FancyNumber" (
  "id",
  "value",
  "status",
  "source",
  "sortOrder",
  "createdByUserID",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  lower(u."accountId"),
  'PERMANENT',
  'LEGACY',
  0,
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "User" u
WHERE u."fancyNumber" = true;

INSERT INTO "FancyNumberLease" (
  "id",
  "userID",
  "fancyNumberID",
  "restoreAccountId",
  "startedAt",
  "expiresAt",
  "permanentAt",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid()::text,
  u."id",
  fn."id",
  NULL,
  u."createdAt",
  NULL,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "User" u
JOIN "FancyNumber" fn ON fn."value" = lower(u."accountId")
WHERE u."fancyNumber" = true;

INSERT INTO "FancyNumberOrder" (
  "id",
  "idempotencyKey",
  "requestFingerprint",
  "type",
  "userID",
  "fancyNumberID",
  "leaseID",
  "months",
  "unitPrice",
  "totalPrice",
  "walletBalanceAfter",
  "previousExpiresAt",
  "newExpiresAt",
  "createdAt"
)
SELECT
  gen_random_uuid()::text,
  'legacy-grant:' || u."id" || ':' || fn."id",
  'legacy-grant:' || u."id" || ':' || fn."id",
  'LEGACY_GRANT',
  u."id",
  fn."id",
  lease."id",
  NULL,
  0,
  0,
  NULL,
  NULL,
  NULL,
  CURRENT_TIMESTAMP
FROM "User" u
JOIN "FancyNumber" fn ON fn."value" = lower(u."accountId")
JOIN "FancyNumberLease" lease
  ON lease."userID" = u."id"
  AND lease."fancyNumberID" = fn."id"
  AND lease."endedAt" IS NULL
WHERE u."fancyNumber" = true;

UPDATE "User"
SET
  "fancyNumberPermanent" = true,
  "fancyNumberExpiresAt" = NULL
WHERE "fancyNumber" = true;

ALTER TABLE "AccountIdentifier"
  ADD CONSTRAINT "AccountIdentifier_currentUserID_fkey"
  FOREIGN KEY ("currentUserID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountIdentifier_reservedForUserID_fkey"
  FOREIGN KEY ("reservedForUserID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AccountIdentifier_inviteOwnerUserID_fkey"
  FOREIGN KEY ("inviteOwnerUserID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FancyNumber"
  ADD CONSTRAINT "FancyNumber_value_fkey"
  FOREIGN KEY ("value") REFERENCES "AccountIdentifier"("value")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FancyNumber_createdByUserID_fkey"
  FOREIGN KEY ("createdByUserID") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "FancyNumberLease"
  ADD CONSTRAINT "FancyNumberLease_userID_fkey"
  FOREIGN KEY ("userID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FancyNumberLease_fancyNumberID_fkey"
  FOREIGN KEY ("fancyNumberID") REFERENCES "FancyNumber"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FancyNumberOrder"
  ADD CONSTRAINT "FancyNumberOrder_userID_fkey"
  FOREIGN KEY ("userID") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FancyNumberOrder_fancyNumberID_fkey"
  FOREIGN KEY ("fancyNumberID") REFERENCES "FancyNumber"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "FancyNumberOrder_leaseID_fkey"
  FOREIGN KEY ("leaseID") REFERENCES "FancyNumberLease"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "User"
  ADD CONSTRAINT "User_accountId_registry_fkey"
  FOREIGN KEY ("accountId") REFERENCES "AccountIdentifier"("value")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "User_account_identifier_prepare"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  occupied BOOLEAN;
BEGIN
  NEW."accountId" := lower(NEW."accountId");
  NEW."inviteCode" := lower(NEW."inviteCode");

  -- Serialize every claim decision for this shared namespace. The existing
  -- unique constraints cannot prevent an accountId in one row racing an
  -- inviteCode in another row because those values live in separate columns.
  -- A stable sort prevents deadlocks when both identifiers change together.
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

    -- Fancy-number purchase/expiry pre-assigns the destination claim inside
    -- the same transaction. For an ordinary account-id change, create the
    -- empty destination first, release the old unique user claim, then assign
    -- the new one. Assigning first would violate currentUserID's uniqueness.
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

CREATE OR REPLACE FUNCTION "User_account_identifier_assign"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "AccountIdentifier"
  SET
    "currentUserID" = NEW."id",
    "inviteOwnerUserID" = CASE
      WHEN "value" = NEW."inviteCode" THEN NEW."id"
      ELSE "inviteOwnerUserID"
    END,
    "updatedAt" = CURRENT_TIMESTAMP
  WHERE "value" = NEW."accountId";

  IF NEW."inviteCode" <> NEW."accountId" THEN
    UPDATE "AccountIdentifier"
    SET
      "inviteOwnerUserID" = NEW."id",
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "value" = NEW."inviteCode";
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

CREATE TRIGGER "User_account_identifier_prepare_trigger"
BEFORE INSERT OR UPDATE OF "accountId", "inviteCode" ON "User"
FOR EACH ROW EXECUTE FUNCTION "User_account_identifier_prepare"();

CREATE TRIGGER "User_account_identifier_assign_trigger"
AFTER INSERT ON "User"
FOR EACH ROW EXECUTE FUNCTION "User_account_identifier_assign"();

CREATE TRIGGER "User_account_identifier_cleanup_trigger"
AFTER UPDATE OF "accountId", "inviteCode" ON "User"
FOR EACH ROW EXECUTE FUNCTION "User_account_identifier_cleanup"();

COMMIT;
