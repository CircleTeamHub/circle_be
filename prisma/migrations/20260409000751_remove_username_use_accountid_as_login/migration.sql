-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED', 'DELETED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'unset');

-- CreateEnum
CREATE TYPE "FriendState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('NEW_SQUAD', 'JOIN_SQUAD', 'GOAL_COMPLETE', 'TRACE', 'POST');

-- CreateEnum
CREATE TYPE "SquadType" AS ENUM ('SELF', 'GROUP', 'CHAT');

-- CreateEnum
CREATE TYPE "SquadStatus" AS ENUM ('ACTIVE', 'DELETED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SquadVisibility" AS ENUM ('PUBLIC', 'PROTECTED', 'PRIVATE');

-- CreateEnum
CREATE TYPE "AddPolicy" AS ENUM ('OPEN', 'INVITE_ONLY', 'PAID_ONLY', 'CLOSED');

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('admin', 'member');

-- CreateEnum
CREATE TYPE "SquadRequestState" AS ENUM ('APPROVED', 'REJECTED', 'PENDING', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('COMING', 'LIVE', 'FINISHED', 'CANCELED');

-- CreateEnum
CREATE TYPE "TraceType" AS ENUM ('MOMENT');

-- CreateEnum
CREATE TYPE "TraceVisibility" AS ENUM ('PRIVATE', 'PUBLIC', 'FRIENDS_ONLY');

-- CreateEnum
CREATE TYPE "UserTracePreferenceType" AS ENUM ('HIDE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SQUAD_REQUEST_RECEIVED', 'SQUAD_REQUEST_ACCEPTED', 'SQUAD_REQUEST_REJECTED', 'FRIEND_REQUEST_RECEIVED', 'FRIEND_REQUEST_ACCEPTED', 'FRIEND_REQUEST_REJECTED', 'SYSTEM', 'TRACE_LIKE', 'TRACE_COMMENT', 'COMMENT_REPLY');

-- CreateEnum
CREATE TYPE "MissionType" AS ENUM ('DAILY', 'CONTENT', 'CREATIVE');

-- CreateEnum
CREATE TYPE "MissionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RUNNING', 'COMPLETED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CheckinCycle" AS ENUM ('DAILY', 'WEEKLY', 'FLEXIBLE');

-- CreateEnum
CREATE TYPE "CheckinStatus" AS ENUM ('PASSED', 'FAILED', 'PENDING');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('CREATOR', 'MEMBER');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "avatarFrame" TEXT,
    "cover" TEXT,
    "email" TEXT,
    "phoneNumber" TEXT,
    "wechat" TEXT,
    "qq" TEXT,
    "whatsup" TEXT,
    "persona" TEXT,
    "helloWords" TEXT,
    "birthday" TIMESTAMP(3),
    "gender" "Gender" NOT NULL DEFAULT 'unset',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastOnline" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefreshToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "deviceName" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiredAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Friend" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "friendID" TEXT NOT NULL,
    "state" "FriendState" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Friend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Activity" (
    "id" TEXT NOT NULL,
    "type" "ActionType" NOT NULL,
    "userID" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Squad" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "groupType" "SquadType" NOT NULL DEFAULT 'GROUP',
    "status" "SquadStatus" NOT NULL DEFAULT 'ACTIVE',
    "avatar" TEXT,
    "cover" TEXT,
    "description" TEXT,
    "theme" TEXT,
    "visibility" "SquadVisibility" NOT NULL DEFAULT 'PUBLIC',
    "addPolicy" "AddPolicy" NOT NULL DEFAULT 'OPEN',
    "creatorID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Squad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadMember" (
    "id" TEXT NOT NULL,
    "userID" TEXT,
    "role" "MemberRole" NOT NULL DEFAULT 'member',
    "nickname" TEXT,
    "avatar" TEXT,
    "cover" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "fromSquadID" TEXT NOT NULL,
    "height" INTEGER,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquadMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "avatar" TEXT,
    "cover" TEXT,
    "start" TIMESTAMP(3) NOT NULL,
    "end" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "EventStatus" NOT NULL DEFAULT 'LIVE',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "squadID" TEXT NOT NULL,
    "squadMemberID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SquadRequest" (
    "id" TEXT NOT NULL,
    "fromUserID" TEXT,
    "content" TEXT,
    "status" "SquadRequestState" NOT NULL DEFAULT 'PENDING',
    "toSquadID" TEXT,
    "toUserID" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SquadRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trace" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "content" TEXT NOT NULL DEFAULT '',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "TraceVisibility" NOT NULL DEFAULT 'PUBLIC',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "type" "TraceType" NOT NULL,
    "fromID" TEXT NOT NULL,
    "likeCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "shareCount" INTEGER NOT NULL DEFAULT 0,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceComment" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "traceID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "replyToID" TEXT,
    "parentID" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraceComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traceLikeStat" (
    "id" TEXT NOT NULL,
    "traceID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traceLikeStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traceViewedStat" (
    "id" TEXT NOT NULL,
    "traceID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traceViewedStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserTracePreference" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "traceID" TEXT NOT NULL,
    "type" "UserTracePreferenceType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTracePreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagOnTrace" (
    "id" TEXT NOT NULL,
    "tagID" TEXT NOT NULL,
    "traceID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagOnTrace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagOnUser" (
    "id" TEXT NOT NULL,
    "tagID" TEXT NOT NULL,
    "userID" TEXT,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagOnUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TagOnSquad" (
    "id" TEXT NOT NULL,
    "tagID" TEXT NOT NULL,
    "squadID" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TagOnSquad_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "type" "NotificationType" NOT NULL,
    "toUserID" TEXT,
    "fromUserID" TEXT NOT NULL,
    "squadRequestID" TEXT,
    "fromTraceID" TEXT,
    "fromReplyID" TEXT,
    "toReplyID" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BadgeTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "maximumCount" INTEGER NOT NULL DEFAULT 100,
    "authorID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BadgeTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BadgeSource" (
    "id" TEXT NOT NULL,
    "parentID" TEXT NOT NULL,
    "traceID" TEXT,
    "userID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BadgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BadgeInstance" (
    "id" TEXT NOT NULL,
    "metadata" JSONB,
    "sourceID" TEXT NOT NULL,
    "badgeID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BadgeInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBadgeCount" (
    "id" TEXT NOT NULL,
    "badgeID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserBadgeCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mission" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "type" "MissionType" NOT NULL,
    "status" "MissionStatus" NOT NULL,
    "creatorId" TEXT NOT NULL,
    "squadId" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "checkinCycle" "CheckinCycle" NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionCheckin" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "CheckinStatus" NOT NULL,
    "content" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionCheckin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MissionParticipant" (
    "id" TEXT NOT NULL,
    "missionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ParticipantRole" NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MissionParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImageCaption" (
    "id" TEXT NOT NULL,
    "imageKey" TEXT NOT NULL,
    "caption" TEXT NOT NULL,

    CONSTRAINT "ImageCaption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecommendationFeedback" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "feedbackType" TEXT NOT NULL,
    "reason" TEXT,
    "position" INTEGER,
    "sessionId" TEXT,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecommendationFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserBlockedContent" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "traceID" TEXT,
    "creatorID" TEXT,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserBlockedContent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_accountId_key" ON "User"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Friend_userID_idx" ON "Friend"("userID");

-- CreateIndex
CREATE INDEX "Friend_friendID_idx" ON "Friend"("friendID");

-- CreateIndex
CREATE UNIQUE INDEX "Friend_userID_friendID_key" ON "Friend"("userID", "friendID");

-- CreateIndex
CREATE INDEX "Activity_userID_idx" ON "Activity"("userID");

-- CreateIndex
CREATE INDEX "Squad_creatorID_idx" ON "Squad"("creatorID");

-- CreateIndex
CREATE INDEX "Squad_visibility_status_idx" ON "Squad"("visibility", "status");

-- CreateIndex
CREATE INDEX "SquadMember_userID_fromSquadID_deleted_idx" ON "SquadMember"("userID", "fromSquadID", "deleted");

-- CreateIndex
CREATE INDEX "Event_squadID_squadMemberID_idx" ON "Event"("squadID", "squadMemberID");

-- CreateIndex
CREATE INDEX "SquadRequest_fromUserID_idx" ON "SquadRequest"("fromUserID");

-- CreateIndex
CREATE INDEX "SquadRequest_toSquadID_idx" ON "SquadRequest"("toSquadID");

-- CreateIndex
CREATE INDEX "Trace_fromID_idx" ON "Trace"("fromID");

-- CreateIndex
CREATE INDEX "TraceComment_traceID_idx" ON "TraceComment"("traceID");

-- CreateIndex
CREATE INDEX "TraceComment_userID_idx" ON "TraceComment"("userID");

-- CreateIndex
CREATE UNIQUE INDEX "traceViewedStat_userID_traceID_key" ON "traceViewedStat"("userID", "traceID");

-- CreateIndex
CREATE INDEX "UserTracePreference_userID_idx" ON "UserTracePreference"("userID");

-- CreateIndex
CREATE INDEX "UserTracePreference_traceID_idx" ON "UserTracePreference"("traceID");

-- CreateIndex
CREATE UNIQUE INDEX "UserTracePreference_userID_traceID_key" ON "UserTracePreference"("userID", "traceID");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "Tag_name_deleted_idx" ON "Tag"("name", "deleted");

-- CreateIndex
CREATE INDEX "TagOnUser_userID_order_idx" ON "TagOnUser"("userID", "order");

-- CreateIndex
CREATE INDEX "TagOnSquad_squadID_order_idx" ON "TagOnSquad"("squadID", "order");

-- CreateIndex
CREATE INDEX "Notification_fromUserID_toUserID_idx" ON "Notification"("fromUserID", "toUserID");

-- CreateIndex
CREATE INDEX "Notification_toUserID_idx" ON "Notification"("toUserID");

-- CreateIndex
CREATE UNIQUE INDEX "BadgeTemplate_name_key" ON "BadgeTemplate"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BadgeTemplate_icon_key" ON "BadgeTemplate"("icon");

-- CreateIndex
CREATE INDEX "BadgeInstance_userID_sourceID_idx" ON "BadgeInstance"("userID", "sourceID");

-- CreateIndex
CREATE INDEX "UserBadgeCount_badgeID_userID_idx" ON "UserBadgeCount"("badgeID", "userID");

-- CreateIndex
CREATE INDEX "Mission_creatorId_idx" ON "Mission"("creatorId");

-- CreateIndex
CREATE INDEX "Mission_squadId_idx" ON "Mission"("squadId");

-- CreateIndex
CREATE INDEX "Mission_status_idx" ON "Mission"("status");

-- CreateIndex
CREATE INDEX "MissionCheckin_missionId_idx" ON "MissionCheckin"("missionId");

-- CreateIndex
CREATE INDEX "MissionCheckin_userId_idx" ON "MissionCheckin"("userId");

-- CreateIndex
CREATE INDEX "MissionParticipant_missionId_idx" ON "MissionParticipant"("missionId");

-- CreateIndex
CREATE INDEX "MissionParticipant_userId_idx" ON "MissionParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "MissionParticipant_missionId_userId_key" ON "MissionParticipant"("missionId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "ImageCaption_imageKey_key" ON "ImageCaption"("imageKey");

-- CreateIndex
CREATE INDEX "ImageCaption_imageKey_idx" ON "ImageCaption"("imageKey");

-- CreateIndex
CREATE INDEX "RecommendationFeedback_userID_createdAt_idx" ON "RecommendationFeedback"("userID", "createdAt");

-- CreateIndex
CREATE INDEX "RecommendationFeedback_targetType_targetId_idx" ON "RecommendationFeedback"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "RecommendationFeedback_processed_createdAt_idx" ON "RecommendationFeedback"("processed", "createdAt");

-- CreateIndex
CREATE INDEX "UserBlockedContent_userID_creatorID_idx" ON "UserBlockedContent"("userID", "creatorID");

-- CreateIndex
CREATE UNIQUE INDEX "UserBlockedContent_userID_traceID_key" ON "UserBlockedContent"("userID", "traceID");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_friendID_fkey" FOREIGN KEY ("friendID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Squad" ADD CONSTRAINT "Squad_creatorID_fkey" FOREIGN KEY ("creatorID") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadMember" ADD CONSTRAINT "SquadMember_fromSquadID_fkey" FOREIGN KEY ("fromSquadID") REFERENCES "Squad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadMember" ADD CONSTRAINT "SquadMember_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_squadID_fkey" FOREIGN KEY ("squadID") REFERENCES "Squad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_squadMemberID_fkey" FOREIGN KEY ("squadMemberID") REFERENCES "SquadMember"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadRequest" ADD CONSTRAINT "SquadRequest_fromUserID_fkey" FOREIGN KEY ("fromUserID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadRequest" ADD CONSTRAINT "SquadRequest_toSquadID_fkey" FOREIGN KEY ("toSquadID") REFERENCES "Squad"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SquadRequest" ADD CONSTRAINT "SquadRequest_toUserID_fkey" FOREIGN KEY ("toUserID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trace" ADD CONSTRAINT "Trace_fromID_fkey" FOREIGN KEY ("fromID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceComment" ADD CONSTRAINT "TraceComment_traceID_fkey" FOREIGN KEY ("traceID") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceComment" ADD CONSTRAINT "TraceComment_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceComment" ADD CONSTRAINT "TraceComment_parentID_fkey" FOREIGN KEY ("parentID") REFERENCES "TraceComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceComment" ADD CONSTRAINT "TraceComment_replyToID_fkey" FOREIGN KEY ("replyToID") REFERENCES "TraceComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traceLikeStat" ADD CONSTRAINT "traceLikeStat_traceID_fkey" FOREIGN KEY ("traceID") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traceLikeStat" ADD CONSTRAINT "traceLikeStat_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traceViewedStat" ADD CONSTRAINT "traceViewedStat_traceID_fkey" FOREIGN KEY ("traceID") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traceViewedStat" ADD CONSTRAINT "traceViewedStat_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTracePreference" ADD CONSTRAINT "UserTracePreference_traceID_fkey" FOREIGN KEY ("traceID") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTracePreference" ADD CONSTRAINT "UserTracePreference_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnTrace" ADD CONSTRAINT "TagOnTrace_tagID_fkey" FOREIGN KEY ("tagID") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnTrace" ADD CONSTRAINT "TagOnTrace_traceID_fkey" FOREIGN KEY ("traceID") REFERENCES "Trace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnUser" ADD CONSTRAINT "TagOnUser_tagID_fkey" FOREIGN KEY ("tagID") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnUser" ADD CONSTRAINT "TagOnUser_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnSquad" ADD CONSTRAINT "TagOnSquad_tagID_fkey" FOREIGN KEY ("tagID") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagOnSquad" ADD CONSTRAINT "TagOnSquad_squadID_fkey" FOREIGN KEY ("squadID") REFERENCES "Squad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_toUserID_fkey" FOREIGN KEY ("toUserID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromUserID_fkey" FOREIGN KEY ("fromUserID") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_squadRequestID_fkey" FOREIGN KEY ("squadRequestID") REFERENCES "SquadRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromTraceID_fkey" FOREIGN KEY ("fromTraceID") REFERENCES "Trace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromReplyID_fkey" FOREIGN KEY ("fromReplyID") REFERENCES "TraceComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_toReplyID_fkey" FOREIGN KEY ("toReplyID") REFERENCES "TraceComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeTemplate" ADD CONSTRAINT "BadgeTemplate_authorID_fkey" FOREIGN KEY ("authorID") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeSource" ADD CONSTRAINT "BadgeSource_parentID_fkey" FOREIGN KEY ("parentID") REFERENCES "BadgeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeSource" ADD CONSTRAINT "BadgeSource_traceID_fkey" FOREIGN KEY ("traceID") REFERENCES "Trace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeSource" ADD CONSTRAINT "BadgeSource_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeInstance" ADD CONSTRAINT "BadgeInstance_badgeID_fkey" FOREIGN KEY ("badgeID") REFERENCES "BadgeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeInstance" ADD CONSTRAINT "BadgeInstance_sourceID_fkey" FOREIGN KEY ("sourceID") REFERENCES "BadgeSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BadgeInstance" ADD CONSTRAINT "BadgeInstance_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadgeCount" ADD CONSTRAINT "UserBadgeCount_badgeID_fkey" FOREIGN KEY ("badgeID") REFERENCES "BadgeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBadgeCount" ADD CONSTRAINT "UserBadgeCount_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mission" ADD CONSTRAINT "Mission_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionCheckin" ADD CONSTRAINT "MissionCheckin_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionParticipant" ADD CONSTRAINT "MissionParticipant_missionId_fkey" FOREIGN KEY ("missionId") REFERENCES "Mission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MissionParticipant" ADD CONSTRAINT "MissionParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecommendationFeedback" ADD CONSTRAINT "RecommendationFeedback_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserBlockedContent" ADD CONSTRAINT "UserBlockedContent_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
