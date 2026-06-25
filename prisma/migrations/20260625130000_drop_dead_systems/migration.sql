-- Drop dead systems: Squad, Mission, Event, Activity, content Tag, Badge*, and
-- analytics/recommendation tables. These had zero business-code references.
-- The live badge feature uses IconAsset / UserDisplayIcon (kept); FriendTag,
-- FriendActivity and traceLikeStat are live and kept.

-- 1) Detach the live Notification model from the dead SquadRequest table.
ALTER TABLE "Notification" DROP COLUMN IF EXISTS "squadRequestID";

-- 2) Drop dead tables. CASCADE clears the inter-(dead-)table FK constraints and
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

-- 3) Drop now-unused enum types (plain DROP — errors if any live column still
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
