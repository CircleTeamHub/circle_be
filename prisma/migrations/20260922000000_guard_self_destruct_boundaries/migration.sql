-- Rolling-deploy compatibility: binaries predating the start-boundary columns
-- write only the duration. Keep their writes from retroactively hiding history.
CREATE OR REPLACE FUNCTION "guard_chat_burn_boundary"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."burnDurationSec" IS NULL OR NEW."burnDurationSec" <= 0 THEN
    NEW."burnStartedAt" := NULL;
  ELSIF NEW."burnDurationSec" > 0 AND NEW."burnStartedAt" IS NULL AND (
    TG_OP = 'INSERT'
    OR OLD."burnDurationSec" IS NULL
    OR OLD."burnDurationSec" <= 0
  ) THEN
    NEW."burnStartedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ChatConversation_guard_burn_boundary" ON "ChatConversation";
CREATE TRIGGER "ChatConversation_guard_burn_boundary"
BEFORE INSERT OR UPDATE OF "burnDurationSec", "burnStartedAt"
ON "ChatConversation"
FOR EACH ROW
EXECUTE FUNCTION "guard_chat_burn_boundary"();

CREATE OR REPLACE FUNCTION "guard_user_self_destruct_boundary"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."messageSelfDestructSec" IS NULL OR NEW."messageSelfDestructSec" <= 0 THEN
    NEW."messageSelfDestructStartedAt" := NULL;
  ELSIF NEW."messageSelfDestructSec" > 0
    AND NEW."messageSelfDestructStartedAt" IS NULL AND (
    TG_OP = 'INSERT'
    OR OLD."messageSelfDestructSec" IS NULL
    OR OLD."messageSelfDestructSec" <= 0
  ) THEN
    NEW."messageSelfDestructStartedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "UserPrivacySetting_guard_self_destruct_boundary" ON "UserPrivacySetting";
CREATE TRIGGER "UserPrivacySetting_guard_self_destruct_boundary"
BEFORE INSERT OR UPDATE OF "messageSelfDestructSec", "messageSelfDestructStartedAt"
ON "UserPrivacySetting"
FOR EACH ROW
EXECUTE FUNCTION "guard_user_self_destruct_boundary"();
