-- Drop dead systems: Squad, Mission, Event, Activity, content Tag, Badge*, and
-- analytics/recommendation tables. These had zero business-code references.
-- The live badge feature uses IconAsset / UserDisplayIcon (kept); FriendTag,
-- FriendActivity and traceLikeStat are live and kept.

-- 1) Safety gate. This migration is intentionally destructive, so abort if the
--    supposedly-dead tables still contain rows or live notifications still point
--    at SquadRequest. Empty tables are safe to drop; non-empty ones require an
--    explicit archive/backfill decision outside this migration.
DO $$
DECLARE
  dead_table text;
  row_count bigint;
  notification_refs bigint;
  dead_tables text[] := ARRAY[
    'Activity',
    'SquadRequest',
    'Event',
    'SquadMember',
    'Squad',
    'TagOnTrace',
    'TagOnUser',
    'TagOnSquad',
    'Tag',
    'BadgeInstance',
    'UserBadgeCount',
    'BadgeSource',
    'BadgeTemplate',
    'MissionCheckin',
    'MissionParticipant',
    'Mission',
    'traceViewedStat',
    'ImageCaption',
    'RecommendationFeedback',
    'UserBlockedContent'
  ];
BEGIN
  IF to_regclass('"Notification"') IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'Notification'
        AND column_name = 'squadRequestID'
    )
  THEN
    EXECUTE 'SELECT count(*) FROM "Notification" WHERE "squadRequestID" IS NOT NULL'
      INTO notification_refs;
    IF notification_refs > 0 THEN
      RAISE EXCEPTION '"Notification"."squadRequestID" still has % rows; audit or clear them before dropping dead systems', notification_refs;
    END IF;
  END IF;

  FOREACH dead_table IN ARRAY dead_tables LOOP
    IF to_regclass(format('"%s"', dead_table)) IS NOT NULL THEN
      EXECUTE format(
        'SELECT count(*) FROM %s',
        to_regclass(format('"%s"', dead_table))
      ) INTO row_count;
      IF row_count > 0 THEN
        RAISE EXCEPTION 'dead system table "%" is not empty (% rows); audit or archive it before dropping dead systems', dead_table, row_count;
      END IF;
    END IF;
  END LOOP;
END $$;

-- 2) Detach the live Notification model from the dead SquadRequest table.
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "squadRequestID";

-- 3) Drop dead tables. CASCADE clears the inter-(dead-)table FK constraints and
--    their indexes; no live table FKs into these after step 1.
DROP TABLE IF EXISTS "Activity" CASCADE;
DROP TABLE IF EXISTS "SquadRequest" CASCADE;
DROP TABLE IF EXISTS "Event" CASCADE;
DROP TABLE IF EXISTS "SquadMember" CASCADE;
DROP TABLE IF EXISTS "Squad" CASCADE;
DROP TABLE IF EXISTS "TagOnTrace" CASCADE;
DROP TABLE IF EXISTS "TagOnUser" CASCADE;
DROP TABLE IF EXISTS "TagOnSquad" CASCADE;
DROP TABLE IF EXISTS "Tag" CASCADE;
DROP TABLE IF EXISTS "BadgeInstance" CASCADE;
DROP TABLE IF EXISTS "UserBadgeCount" CASCADE;
DROP TABLE IF EXISTS "BadgeSource" CASCADE;
DROP TABLE IF EXISTS "BadgeTemplate" CASCADE;
DROP TABLE IF EXISTS "MissionCheckin" CASCADE;
DROP TABLE IF EXISTS "MissionParticipant" CASCADE;
DROP TABLE IF EXISTS "Mission" CASCADE;
DROP TABLE IF EXISTS "traceViewedStat" CASCADE;
DROP TABLE IF EXISTS "ImageCaption" CASCADE;
DROP TABLE IF EXISTS "RecommendationFeedback" CASCADE;
DROP TABLE IF EXISTS "UserBlockedContent" CASCADE;

-- 4) Drop now-unused enum types (plain DROP — errors if any live column still
--    references one, which would surface a missed dependency instead of
--    silently cascading).
DROP TYPE IF EXISTS "ActionType";
DROP TYPE IF EXISTS "SquadType";
DROP TYPE IF EXISTS "SquadStatus";
DROP TYPE IF EXISTS "SquadVisibility";
DROP TYPE IF EXISTS "AddPolicy";
DROP TYPE IF EXISTS "MemberRole";
DROP TYPE IF EXISTS "SquadRequestState";
DROP TYPE IF EXISTS "EventStatus";
DROP TYPE IF EXISTS "MissionType";
DROP TYPE IF EXISTS "MissionStatus";
DROP TYPE IF EXISTS "CheckinCycle";
DROP TYPE IF EXISTS "CheckinStatus";
DROP TYPE IF EXISTS "ParticipantRole";
