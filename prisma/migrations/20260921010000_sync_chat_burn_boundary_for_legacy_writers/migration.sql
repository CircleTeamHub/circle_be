-- Old application instances only write burnDurationSec during a blue/green
-- rollout. Keep the durable activation boundary correct until every old color
-- is gone, without overriding a timestamp explicitly supplied by the new code.

-- Clear stale values left by a pre-trigger legacy disable. This is what makes
-- the next legacy re-enable start a fresh retention window.
UPDATE "ChatConversation"
SET "burnStartedAt" = NULL
WHERE COALESCE("burnDurationSec", 0) <= 0
  AND "burnStartedAt" IS NOT NULL;

CREATE OR REPLACE FUNCTION sync_chat_conversation_burn_started_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW."burnDurationSec", 0) <= 0 THEN
      NEW."burnStartedAt" := NULL;
    ELSIF NEW."burnStartedAt" IS NULL THEN
      NEW."burnStartedAt" := CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
  END IF;

  IF COALESCE(NEW."burnDurationSec", 0) <= 0 THEN
    NEW."burnStartedAt" := NULL;
  ELSIF COALESCE(OLD."burnDurationSec", 0) <= 0
    AND NEW."burnStartedAt" IS NOT DISTINCT FROM OLD."burnStartedAt" THEN
    -- A legacy writer changed only burnDurationSec. New writers provide their
    -- own timestamp, which is distinct from the old disabled-row value.
    NEW."burnStartedAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ChatConversation_sync_burn_started_at"
ON "ChatConversation";

CREATE TRIGGER "ChatConversation_sync_burn_started_at"
BEFORE INSERT OR UPDATE OF "burnDurationSec", "burnStartedAt"
ON "ChatConversation"
FOR EACH ROW
EXECUTE FUNCTION sync_chat_conversation_burn_started_at();
