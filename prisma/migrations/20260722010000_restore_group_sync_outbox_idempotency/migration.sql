BEGIN;

ALTER TABLE "GroupSyncOutbox"
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "processingGeneration" INTEGER,
  ADD COLUMN "processingOperation" "GroupSyncOperation";

-- Collapse historical jobs into one durable desired-state row per group member.
-- Desired intent is always the chronologically newest row, regardless of status.
-- Independently retain the newest PROCESSING attempt so lease recovery replays
-- that uncertain external effect before advancing to the latest desired operation.
WITH ranked_desired AS (
  SELECT
    job.*,
    ROW_NUMBER() OVER (
      PARTITION BY job."groupID", job."userID"
      ORDER BY
        job."createdAt" DESC,
        job."id" DESC
    ) AS desired_rank
  FROM "GroupSyncOutbox" AS job
),
desired AS (
  SELECT * FROM ranked_desired WHERE desired_rank = 1
),
processing AS (
  SELECT DISTINCT ON (job."groupID", job."userID")
    job."id",
    job."groupID",
    job."userID",
    job."operation",
    job."lockedAt",
    job."updatedAt"
  FROM "GroupSyncOutbox" AS job
  WHERE job."status" = 'PROCESSING'
  ORDER BY job."groupID", job."userID", job."createdAt" DESC, job."id" DESC
)
UPDATE "GroupSyncOutbox" AS retained
SET
  "generation" = CASE
    WHEN processing."id" IS NOT NULL AND processing."id" <> desired."id" THEN 2
    ELSE 1
  END,
  "processingGeneration" = CASE
    WHEN processing."id" IS NOT NULL THEN 1
    ELSE NULL
  END,
  "processingOperation" = processing."operation",
  "lockedAt" = CASE
    WHEN processing."id" IS NOT NULL
      THEN COALESCE(processing."lockedAt", processing."updatedAt", CURRENT_TIMESTAMP)
    ELSE NULL
  END,
  "status" = CASE
    WHEN processing."id" = desired."id" THEN 'PROCESSING'::"GroupSyncStatus"
    WHEN processing."id" IS NOT NULL THEN 'PENDING'::"GroupSyncStatus"
    ELSE desired."status"
  END,
  "processedAt" = CASE
    WHEN processing."id" IS NOT NULL AND processing."id" <> desired."id" THEN NULL
    ELSE desired."processedAt"
  END,
  "updatedAt" = CURRENT_TIMESTAMP
FROM desired
LEFT JOIN processing
  ON processing."groupID" = desired."groupID"
 AND processing."userID" = desired."userID"
WHERE retained."id" = desired."id";

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "groupID", "userID"
      ORDER BY
        "createdAt" DESC,
        "id" DESC
    ) AS desired_rank
  FROM "GroupSyncOutbox"
)
DELETE FROM "GroupSyncOutbox" AS discarded
USING ranked
WHERE discarded."id" = ranked."id"
  AND ranked.desired_rank > 1;

-- Validate the exact archived and prior desired-state partial indexes before
-- replacing either with the one-row unique key. Probe indexes let PostgreSQL
-- define the canonical access method, operator classes and predicate form.
CREATE UNIQUE INDEX "__GroupSyncOutbox_desired_probe_20260722010000"
ON "GroupSyncOutbox"("groupID", "userID")
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');

CREATE UNIQUE INDEX "__GroupSyncOutbox_legacy_probe_20260722010000"
ON "GroupSyncOutbox"("operation", "groupID", "userID")
WHERE "status" IN ('PENDING', 'PROCESSING', 'FAILED');

DO $$
DECLARE
  existing_oid oid;
  desired_oid oid;
  legacy_oid oid;
  key_columns text[];
  exact_desired boolean := false;
  exact_legacy boolean := false;
  existing_definition text;
BEGIN
  SELECT c.oid
  INTO existing_oid
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = c.relnamespace
  WHERE namespace.nspname = current_schema()
    AND c.relname = 'GroupSyncOutbox_open_active_key'
    AND c.relkind = 'i';

  SELECT c.oid
  INTO desired_oid
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = c.relnamespace
  WHERE namespace.nspname = current_schema()
    AND c.relname = '__GroupSyncOutbox_desired_probe_20260722010000';

  SELECT c.oid
  INTO legacy_oid
  FROM pg_catalog.pg_class AS c
  JOIN pg_catalog.pg_namespace AS namespace
    ON namespace.oid = c.relnamespace
  WHERE namespace.nspname = current_schema()
    AND c.relname = '__GroupSyncOutbox_legacy_probe_20260722010000';

  IF existing_oid IS NOT NULL THEN
    SELECT ARRAY(
      SELECT attribute.attname
      FROM unnest(index_meta.indkey::smallint[]) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = index_meta.indrelid
       AND attribute.attnum = key.attnum
      WHERE key.position <= index_meta.indnkeyatts
      ORDER BY key.position
    )
    INTO key_columns
    FROM pg_catalog.pg_index AS index_meta
    WHERE index_meta.indexrelid = existing_oid;

    SELECT
      current_index.indisunique
      AND current_index.indisvalid
      AND current_index.indisready
      AND current_index.indislive
      AND NOT current_index.indisexclusion
      AND current_index.indimmediate
      AND current_index.indrelid = desired_index.indrelid
      AND current_class.relam = desired_class.relam
      AND current_index.indnatts = desired_index.indnatts
      AND current_index.indnkeyatts = desired_index.indnkeyatts
      AND current_index.indkey = desired_index.indkey
      AND current_index.indcollation = desired_index.indcollation
      AND current_index.indclass = desired_index.indclass
      AND current_index.indoption = desired_index.indoption
      AND current_index.indexprs::text IS NOT DISTINCT FROM desired_index.indexprs::text
      AND pg_catalog.pg_get_expr(current_index.indpred, current_index.indrelid)
        IS NOT DISTINCT FROM
        pg_catalog.pg_get_expr(desired_index.indpred, desired_index.indrelid)
    INTO exact_desired
    FROM pg_catalog.pg_index AS current_index
    JOIN pg_catalog.pg_class AS current_class
      ON current_class.oid = current_index.indexrelid
    CROSS JOIN pg_catalog.pg_index AS desired_index
    JOIN pg_catalog.pg_class AS desired_class
      ON desired_class.oid = desired_index.indexrelid
    WHERE current_index.indexrelid = existing_oid
      AND desired_index.indexrelid = desired_oid;

    SELECT
      current_index.indisunique
      AND current_index.indisvalid
      AND current_index.indisready
      AND current_index.indislive
      AND NOT current_index.indisexclusion
      AND current_index.indimmediate
      AND current_index.indrelid = legacy_index.indrelid
      AND current_class.relam = legacy_class.relam
      AND current_index.indnatts = legacy_index.indnatts
      AND current_index.indnkeyatts = legacy_index.indnkeyatts
      AND current_index.indkey = legacy_index.indkey
      AND current_index.indcollation = legacy_index.indcollation
      AND current_index.indclass = legacy_index.indclass
      AND current_index.indoption = legacy_index.indoption
      AND current_index.indexprs::text IS NOT DISTINCT FROM legacy_index.indexprs::text
      AND pg_catalog.pg_get_expr(current_index.indpred, current_index.indrelid)
        IS NOT DISTINCT FROM
        pg_catalog.pg_get_expr(legacy_index.indpred, legacy_index.indrelid)
    INTO exact_legacy
    FROM pg_catalog.pg_index AS current_index
    JOIN pg_catalog.pg_class AS current_class
      ON current_class.oid = current_index.indexrelid
    CROSS JOIN pg_catalog.pg_index AS legacy_index
    JOIN pg_catalog.pg_class AS legacy_class
      ON legacy_class.oid = legacy_index.indexrelid
    WHERE current_index.indexrelid = existing_oid
      AND legacy_index.indexrelid = legacy_oid;

    exact_desired := exact_desired
      AND key_columns = ARRAY['groupID', 'userID']::text[];
    exact_legacy := exact_legacy
      AND key_columns = ARRAY['operation', 'groupID', 'userID']::text[];

    IF exact_desired OR exact_legacy THEN
      DROP INDEX "GroupSyncOutbox_open_active_key";
    ELSE
      existing_definition := pg_catalog.pg_get_indexdef(existing_oid);
      RAISE EXCEPTION 'Unexpected definition for index GroupSyncOutbox_open_active_key: %',
        existing_definition;
    END IF;
  END IF;

  IF to_regclass('"GroupSyncOutbox_desired_state_key"') IS NOT NULL THEN
    RAISE EXCEPTION 'Unexpected pre-existing index GroupSyncOutbox_desired_state_key';
  END IF;
END
$$;

DROP INDEX "__GroupSyncOutbox_desired_probe_20260722010000";
DROP INDEX "__GroupSyncOutbox_legacy_probe_20260722010000";

CREATE UNIQUE INDEX "GroupSyncOutbox_desired_state_key"
ON "GroupSyncOutbox"("groupID", "userID");

ALTER TABLE "GroupSyncOutbox"
ADD CONSTRAINT "GroupSyncOutbox_processing_state_check"
CHECK (
  (
    "processingGeneration" IS NULL
    AND "processingOperation" IS NULL
    AND "lockedAt" IS NULL
  )
  OR
  (
    "processingGeneration" IS NOT NULL
    AND "processingOperation" IS NOT NULL
    AND "lockedAt" IS NOT NULL
  )
);

COMMIT;
