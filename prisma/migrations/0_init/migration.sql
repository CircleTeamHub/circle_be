-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'BANNED', 'DELETED');

-- CreateEnum
CREATE TYPE "EmailCodePurpose" AS ENUM ('REGISTER', 'LOGIN');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MEMBER', 'USER');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('male', 'female', 'other', 'unset');

-- CreateEnum
CREATE TYPE "FriendState" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "FriendActivityType" AS ENUM ('REQUEST_RECEIVED', 'REQUEST_SENT', 'REQUEST_ACCEPTED_BY_OTHER', 'REQUEST_REJECTED_BY_OTHER', 'REQUEST_ACCEPTED_BY_ME', 'REQUEST_REJECTED_BY_ME', 'REQUEST_WITHDRAWN_BY_OTHER');

-- CreateEnum
CREATE TYPE "NoteStatus" AS ENUM ('ACTIVE', 'UNLISTED', 'DELETED');

-- CreateEnum
CREATE TYPE "NoteMediaType" AS ENUM ('IMAGE', 'VIDEO');

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
CREATE TYPE "CirclePostStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "CircleMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "CircleMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');

-- CreateEnum
CREATE TYPE "GroupSyncOperation" AS ENUM ('ADD_MEMBER', 'REMOVE_MEMBER');

-- CreateEnum
CREATE TYPE "GroupSyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "FriendSyncOperation" AS ENUM ('IMPORT_FRIEND', 'DELETE_FRIEND', 'ADD_BLACKLIST', 'REMOVE_BLACKLIST');

-- CreateEnum
CREATE TYPE "FriendSyncStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "IconAssetSourceType" AS ENUM ('SYSTEM', 'CIRCLE');

-- CreateEnum
CREATE TYPE "UserDisplayIconType" AS ENUM ('SYSTEM', 'CIRCLE');

-- CreateEnum
CREATE TYPE "SystemIconKey" AS ENUM ('VIP', 'NEW_USER');

-- CreateEnum
CREATE TYPE "CircleCategory" AS ENUM ('LIFE', 'FOOD', 'SPORTS', 'SOCIAL', 'GAMING', 'PHOTOGRAPHY', 'WORK', 'TRADE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CircleInvitationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ADMIN_APPROVED');

-- CreateEnum
CREATE TYPE "CircleInvitationVerifierStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('COMING', 'LIVE', 'FINISHED', 'CANCELED');

-- CreateEnum
CREATE TYPE "TraceType" AS ENUM ('MOMENT');

-- CreateEnum
CREATE TYPE "TraceVisibility" AS ENUM ('PRIVATE', 'PUBLIC', 'FRIENDS_ONLY');

-- CreateEnum
CREATE TYPE "UserTracePreferenceType" AS ENUM ('HIDE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('SQUAD_REQUEST_RECEIVED', 'SQUAD_REQUEST_ACCEPTED', 'SQUAD_REQUEST_REJECTED', 'FRIEND_REQUEST_RECEIVED', 'FRIEND_REQUEST_ACCEPTED', 'FRIEND_REQUEST_REJECTED', 'SYSTEM', 'TRACE_LIKE', 'TRACE_COMMENT', 'COMMENT_REPLY', 'CIRCLE_VERIFICATION_REQUESTED', 'CIRCLE_INVITATION_APPROVED', 'CIRCLE_INVITATION_REJECTED', 'CIRCLE_ADMIN_OVERRIDE_APPROVED', 'CIRCLE_POST_SIGNUP_CREATED');

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

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('RINGING', 'ACTIVE', 'ENDED', 'CANCELED', 'MISSED', 'FAILED');

-- CreateEnum
CREATE TYPE "CallParticipantStatus" AS ENUM ('INVITED', 'JOINED', 'LEFT', 'REJECTED', 'MISSED');

-- CreateEnum
CREATE TYPE "CallEndReason" AS ENUM ('NORMAL', 'CANCELED', 'ALL_LEFT', 'NO_ANSWER', 'TIMEOUT', 'NETWORK', 'ERROR');

-- CreateEnum
CREATE TYPE "CoinTxType" AS ENUM ('RECHARGE', 'GIFT_SENT', 'GIFT_RECEIVED', 'REFUND', 'PURCHASE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "CollectionType" AS ENUM ('CHAT', 'VIDEO', 'VOICE', 'MESSAGE', 'NOTE');

-- CreateEnum
CREATE TYPE "TempChatStatus" AS ENUM ('ACTIVE', 'ENDED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "loginSecurityCodeHash" TEXT,
    "securityCodeAttempts" INTEGER NOT NULL DEFAULT 0,
    "securityCodeLockedUntil" TIMESTAMP(3),
    "singleDeviceLoginEnabled" BOOLEAN NOT NULL DEFAULT false,
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
    "city" TEXT,
    "region" TEXT,
    "gender" "Gender" NOT NULL DEFAULT 'unset',
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "vipLevel" INTEGER NOT NULL DEFAULT 0,
    "creditScore" INTEGER NOT NULL DEFAULT 100,
    "fancyNumber" BOOLEAN NOT NULL DEFAULT false,
    "iconPreferencesInitialized" BOOLEAN NOT NULL DEFAULT false,
    "openimSynced" BOOLEAN NOT NULL DEFAULT false,
    "lastOnline" TIMESTAMP(3),
    "activitiesBackfilledAt" TIMESTAMP(3),
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
    "message" TEXT,
    "pendingRemarkBySender" TEXT,
    "remarkA" TEXT,
    "remarkB" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Friend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendReport" (
    "id" TEXT NOT NULL,
    "reporterID" TEXT NOT NULL,
    "targetID" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupReport" (
    "id" TEXT NOT NULL,
    "reporterID" TEXT NOT NULL,
    "groupID" TEXT NOT NULL,
    "circleID" TEXT,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "evidence" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupSyncOutbox" (
    "id" TEXT NOT NULL,
    "operation" "GroupSyncOperation" NOT NULL,
    "status" "GroupSyncStatus" NOT NULL DEFAULT 'PENDING',
    "groupID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupSyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendSyncOutbox" (
    "id" TEXT NOT NULL,
    "operation" "FriendSyncOperation" NOT NULL,
    "status" "FriendSyncStatus" NOT NULL DEFAULT 'PENDING',
    "userID" TEXT NOT NULL,
    "targetUserID" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FriendSyncOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "groupID" TEXT,
    "title" TEXT NOT NULL,
    "content" TEXT,
    "contentJson" JSONB,
    "status" "NoteStatus" NOT NULL DEFAULT 'ACTIVE',
    "available" BOOLEAN NOT NULL DEFAULT true,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "coverMediaID" TEXT,
    "mediaCount" INTEGER NOT NULL DEFAULT 0,
    "imageCount" INTEGER NOT NULL DEFAULT 0,
    "videoCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteShareLink" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "NoteStatus",
    "group" TEXT,
    "groupID" TEXT,
    "search" TEXT,
    "noteIDs" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteMedia" (
    "id" TEXT NOT NULL,
    "noteID" TEXT NOT NULL,
    "type" "NoteMediaType" NOT NULL,
    "objectKey" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "mimeType" TEXT,
    "size" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "posterUrl" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteGroup" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NoteGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NoteGroupMembership" (
    "id" TEXT NOT NULL,
    "noteID" TEXT NOT NULL,
    "groupID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteGroupMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendActivity" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "viewerId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "counterpartyId" TEXT NOT NULL,
    "type" "FriendActivityType" NOT NULL,
    "messageSnapshot" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendTag" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FriendTagOnFriend" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "tagID" TEXT NOT NULL,
    "friendID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendTagOnFriend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingFriendTagOnRequest" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "requestID" TEXT NOT NULL,
    "tagID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingFriendTagOnRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Block" (
    "id" TEXT NOT NULL,
    "blockerID" TEXT NOT NULL,
    "blockedID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Block_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "sessionType" INTEGER NOT NULL,
    "callType" "CallType" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'RINGING',
    "livekitRoomName" TEXT NOT NULL,
    "initiatorID" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedByID" TEXT,
    "endReason" "CallEndReason",
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallParticipant" (
    "id" TEXT NOT NULL,
    "callID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "status" "CallParticipantStatus" NOT NULL DEFAULT 'INVITED',
    "invitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "joinedAt" TIMESTAMP(3),
    "leftAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "missedAt" TIMESTAMP(3),
    "lastTokenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallParticipant_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "ConversationGroup" (
    "id" TEXT NOT NULL,
    "ownerID" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "pinnedToTabs" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationGroupMembership" (
    "groupID" TEXT NOT NULL,
    "conversationID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationGroupMembership_pkey" PRIMARY KEY ("groupID","conversationID")
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
CREATE TABLE "UserPrivacySetting" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "messageSelfDestructDays" INTEGER NOT NULL DEFAULT 2,
    "momentsVisibility" TEXT NOT NULL DEFAULT 'ALL',
    "allowStrangerMessages" BOOLEAN NOT NULL DEFAULT true,
    "showPhone" BOOLEAN NOT NULL DEFAULT false,
    "showWechat" BOOLEAN NOT NULL DEFAULT true,
    "showQQ" BOOLEAN NOT NULL DEFAULT true,
    "addMeByAccount" BOOLEAN NOT NULL DEFAULT true,
    "addMeByPhone" BOOLEAN NOT NULL DEFAULT false,
    "addMeByQrCode" BOOLEAN NOT NULL DEFAULT true,
    "addMeByGroup" BOOLEAN NOT NULL DEFAULT true,
    "callPermission" TEXT NOT NULL DEFAULT 'EVERYONE',
    "groupInvitePermission" TEXT NOT NULL DEFAULT 'EVERYONE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPrivacySetting_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinTransaction" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "type" "CoinTxType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "balance" INTEGER NOT NULL,
    "note" TEXT,
    "relatedID" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoinGift" (
    "id" TEXT NOT NULL,
    "senderID" TEXT NOT NULL,
    "recipientID" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "message" TEXT,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoinGift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserCollection" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "type" "CollectionType" NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "sourceID" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IconAsset" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" "IconAssetSourceType" NOT NULL,
    "imageUrl" TEXT,
    "circleID" TEXT,
    "createdByID" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IconAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserDisplayIcon" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "displayType" "UserDisplayIconType" NOT NULL,
    "systemKey" "SystemIconKey",
    "circleID" TEXT,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserDisplayIcon_pkey" PRIMARY KEY ("id")
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
    "fromCircleID" TEXT,
    "fromCirclePostID" TEXT,
    "fromInvitationID" TEXT,
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

-- CreateTable
CREATE TABLE "Circle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "avatarUrl" TEXT,
    "ownerID" TEXT NOT NULL,
    "currentIconAssetID" TEXT,
    "cities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rules" TEXT NOT NULL DEFAULT '',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "joinVipRestriction" INTEGER,
    "joinCreditRestriction" INTEGER,
    "joinFancyRestriction" BOOLEAN NOT NULL DEFAULT false,
    "maxMembers" INTEGER,
    "memberCanPost" BOOLEAN NOT NULL DEFAULT true,
    "groupID" TEXT,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Circle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleMember" (
    "id" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "circleID" TEXT NOT NULL,
    "role" "CircleMemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "CircleMemberStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircleMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CirclePost" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "city" TEXT,
    "isHorn" BOOLEAN NOT NULL DEFAULT false,
    "noteID" TEXT,
    "vipRestriction" INTEGER,
    "creditRestriction" INTEGER,
    "fancyRestriction" BOOLEAN NOT NULL DEFAULT false,
    "viewCount" INTEGER NOT NULL DEFAULT 0,
    "signupCount" INTEGER NOT NULL DEFAULT 0,
    "signupVipRestriction" INTEGER,
    "signupCreditRestriction" INTEGER,
    "signupFancyRestriction" BOOLEAN NOT NULL DEFAULT false,
    "status" "CirclePostStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorID" TEXT NOT NULL,
    "circleID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CirclePost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CirclePostSignup" (
    "id" TEXT NOT NULL,
    "postID" TEXT NOT NULL,
    "userID" TEXT NOT NULL,
    "seenByAuthor" BOOLEAN NOT NULL DEFAULT false,
    "seenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CirclePostSignup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleInvitation" (
    "id" TEXT NOT NULL,
    "circleID" TEXT NOT NULL,
    "applicantID" TEXT NOT NULL,
    "inviterID" TEXT NOT NULL,
    "requiredCount" INTEGER NOT NULL DEFAULT 10,
    "approvedCount" INTEGER NOT NULL DEFAULT 0,
    "status" "CircleInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CircleInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CircleInvitationVerifier" (
    "id" TEXT NOT NULL,
    "invitationID" TEXT NOT NULL,
    "verifierID" TEXT NOT NULL,
    "addedByID" TEXT NOT NULL,
    "status" "CircleInvitationVerifierStatus" NOT NULL DEFAULT 'PENDING',
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleInvitationVerifier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TempChat" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '临时聊天',
    "status" "TempChatStatus" NOT NULL DEFAULT 'ACTIVE',
    "maxMembers" INTEGER NOT NULL DEFAULT 50,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TempChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TempChatGuest" (
    "id" TEXT NOT NULL,
    "tempChatId" TEXT NOT NULL,
    "imUserId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cleanedUp" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "TempChatGuest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerificationCode" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "EmailCodePurpose" NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerificationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_accountId_key" ON "User"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RefreshToken_token_key" ON "RefreshToken"("token");

-- CreateIndex
CREATE INDEX "RefreshToken_userId_idx" ON "RefreshToken"("userId");

-- CreateIndex
CREATE INDEX "Friend_userID_idx" ON "Friend"("userID");

-- CreateIndex
CREATE INDEX "Friend_friendID_idx" ON "Friend"("friendID");

-- CreateIndex
CREATE INDEX "FriendReport_reporterID_createdAt_idx" ON "FriendReport"("reporterID", "createdAt");

-- CreateIndex
CREATE INDEX "FriendReport_targetID_createdAt_idx" ON "FriendReport"("targetID", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FriendReport_reporterID_targetID_category_key" ON "FriendReport"("reporterID", "targetID", "category");

-- CreateIndex
CREATE INDEX "GroupReport_reporterID_createdAt_idx" ON "GroupReport"("reporterID", "createdAt");

-- CreateIndex
CREATE INDEX "GroupReport_groupID_createdAt_idx" ON "GroupReport"("groupID", "createdAt");

-- CreateIndex
CREATE INDEX "GroupReport_circleID_createdAt_idx" ON "GroupReport"("circleID", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GroupReport_reporterID_groupID_category_key" ON "GroupReport"("reporterID", "groupID", "category");

-- CreateIndex
CREATE INDEX "GroupSyncOutbox_status_nextAttemptAt_idx" ON "GroupSyncOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "GroupSyncOutbox_groupID_userID_status_idx" ON "GroupSyncOutbox"("groupID", "userID", "status");

-- CreateIndex
CREATE INDEX "FriendSyncOutbox_status_nextAttemptAt_idx" ON "FriendSyncOutbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FriendSyncOutbox_userID_targetUserID_status_idx" ON "FriendSyncOutbox"("userID", "targetUserID", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Note_coverMediaID_key" ON "Note"("coverMediaID");

-- CreateIndex
CREATE INDEX "Note_ownerID_status_updatedAt_idx" ON "Note"("ownerID", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "Note_ownerID_pinned_updatedAt_idx" ON "Note"("ownerID", "pinned", "updatedAt");

-- CreateIndex
CREATE INDEX "Note_groupID_idx" ON "Note"("groupID");

-- CreateIndex
CREATE UNIQUE INDEX "NoteShareLink_token_key" ON "NoteShareLink"("token");

-- CreateIndex
CREATE INDEX "NoteShareLink_ownerID_createdAt_idx" ON "NoteShareLink"("ownerID", "createdAt");

-- CreateIndex
CREATE INDEX "NoteShareLink_token_idx" ON "NoteShareLink"("token");

-- CreateIndex
CREATE INDEX "NoteShareLink_expiresAt_idx" ON "NoteShareLink"("expiresAt");

-- CreateIndex
CREATE INDEX "NoteMedia_noteID_sortOrder_idx" ON "NoteMedia"("noteID", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "NoteMedia_noteID_sortOrder_key" ON "NoteMedia"("noteID", "sortOrder");

-- CreateIndex
CREATE INDEX "NoteGroup_ownerID_deletedAt_sortOrder_idx" ON "NoteGroup"("ownerID", "deletedAt", "sortOrder");

-- CreateIndex
CREATE INDEX "NoteGroupMembership_groupID_idx" ON "NoteGroupMembership"("groupID");

-- CreateIndex
CREATE UNIQUE INDEX "NoteGroupMembership_noteID_groupID_key" ON "NoteGroupMembership"("noteID", "groupID");

-- CreateIndex
CREATE INDEX "FriendActivity_requestId_idx" ON "FriendActivity"("requestId");

-- CreateIndex
CREATE INDEX "FriendActivity_viewerId_createdAt_idx" ON "FriendActivity"("viewerId", "createdAt");

-- CreateIndex
CREATE INDEX "FriendActivity_viewerId_readAt_idx" ON "FriendActivity"("viewerId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "FriendActivity_requestId_viewerId_type_key" ON "FriendActivity"("requestId", "viewerId", "type");

-- CreateIndex
CREATE INDEX "FriendTag_ownerID_idx" ON "FriendTag"("ownerID");

-- CreateIndex
CREATE UNIQUE INDEX "FriendTag_ownerID_name_key" ON "FriendTag"("ownerID", "name");

-- CreateIndex
CREATE INDEX "FriendTagOnFriend_ownerID_friendID_idx" ON "FriendTagOnFriend"("ownerID", "friendID");

-- CreateIndex
CREATE UNIQUE INDEX "FriendTagOnFriend_ownerID_tagID_friendID_key" ON "FriendTagOnFriend"("ownerID", "tagID", "friendID");

-- CreateIndex
CREATE INDEX "PendingFriendTagOnRequest_ownerID_requestID_idx" ON "PendingFriendTagOnRequest"("ownerID", "requestID");

-- CreateIndex
CREATE INDEX "PendingFriendTagOnRequest_requestID_idx" ON "PendingFriendTagOnRequest"("requestID");

-- CreateIndex
CREATE UNIQUE INDEX "PendingFriendTagOnRequest_ownerID_requestID_tagID_key" ON "PendingFriendTagOnRequest"("ownerID", "requestID", "tagID");

-- CreateIndex
CREATE INDEX "Block_blockerID_idx" ON "Block"("blockerID");

-- CreateIndex
CREATE INDEX "Block_blockedID_idx" ON "Block"("blockedID");

-- CreateIndex
CREATE UNIQUE INDEX "Block_blockerID_blockedID_key" ON "Block"("blockerID", "blockedID");

-- CreateIndex
CREATE INDEX "Activity_userID_idx" ON "Activity"("userID");

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_livekitRoomName_key" ON "CallSession"("livekitRoomName");

-- CreateIndex
CREATE INDEX "CallSession_conversationID_createdAt_idx" ON "CallSession"("conversationID", "createdAt");

-- CreateIndex
CREATE INDEX "CallSession_initiatorID_status_idx" ON "CallSession"("initiatorID", "status");

-- CreateIndex
CREATE INDEX "CallSession_expiresAt_status_idx" ON "CallSession"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "CallParticipant_userID_status_idx" ON "CallParticipant"("userID", "status");

-- CreateIndex
CREATE INDEX "CallParticipant_callID_status_idx" ON "CallParticipant"("callID", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CallParticipant_callID_userID_key" ON "CallParticipant"("callID", "userID");

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
CREATE INDEX "ConversationGroup_ownerID_idx" ON "ConversationGroup"("ownerID");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationGroup_ownerID_name_key" ON "ConversationGroup"("ownerID", "name");

-- CreateIndex
CREATE INDEX "ConversationGroupMembership_conversationID_idx" ON "ConversationGroupMembership"("conversationID");

-- CreateIndex
CREATE INDEX "Trace_fromID_idx" ON "Trace"("fromID");

-- CreateIndex
CREATE INDEX "TraceComment_traceID_idx" ON "TraceComment"("traceID");

-- CreateIndex
CREATE INDEX "TraceComment_userID_idx" ON "TraceComment"("userID");

-- CreateIndex
CREATE UNIQUE INDEX "traceLikeStat_traceID_userID_key" ON "traceLikeStat"("traceID", "userID");

-- CreateIndex
CREATE UNIQUE INDEX "traceViewedStat_userID_traceID_key" ON "traceViewedStat"("userID", "traceID");

-- CreateIndex
CREATE INDEX "UserTracePreference_userID_idx" ON "UserTracePreference"("userID");

-- CreateIndex
CREATE INDEX "UserTracePreference_traceID_idx" ON "UserTracePreference"("traceID");

-- CreateIndex
CREATE UNIQUE INDEX "UserTracePreference_userID_traceID_key" ON "UserTracePreference"("userID", "traceID");

-- CreateIndex
CREATE UNIQUE INDEX "UserPrivacySetting_userID_key" ON "UserPrivacySetting"("userID");

-- CreateIndex
CREATE INDEX "UserPrivacySetting_userID_idx" ON "UserPrivacySetting"("userID");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_key" ON "Tag"("name");

-- CreateIndex
CREATE INDEX "Tag_name_deleted_idx" ON "Tag"("name", "deleted");

-- CreateIndex
CREATE INDEX "TagOnUser_userID_order_idx" ON "TagOnUser"("userID", "order");

-- CreateIndex
CREATE INDEX "TagOnSquad_squadID_order_idx" ON "TagOnSquad"("squadID", "order");

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_userID_key" ON "Wallet"("userID");

-- CreateIndex
CREATE INDEX "CoinTransaction_userID_createdAt_idx" ON "CoinTransaction"("userID", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "CoinGift_idempotencyKey_key" ON "CoinGift"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CoinGift_senderID_idx" ON "CoinGift"("senderID");

-- CreateIndex
CREATE INDEX "CoinGift_recipientID_idx" ON "CoinGift"("recipientID");

-- CreateIndex
CREATE INDEX "UserCollection_userID_type_createdAt_idx" ON "UserCollection"("userID", "type", "createdAt");

-- CreateIndex
CREATE INDEX "IconAsset_circleID_idx" ON "IconAsset"("circleID");

-- CreateIndex
CREATE INDEX "IconAsset_sourceType_idx" ON "IconAsset"("sourceType");

-- CreateIndex
CREATE INDEX "UserDisplayIcon_userID_sortOrder_idx" ON "UserDisplayIcon"("userID", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "UserDisplayIcon_userID_systemKey_key" ON "UserDisplayIcon"("userID", "systemKey");

-- CreateIndex
CREATE UNIQUE INDEX "UserDisplayIcon_userID_circleID_key" ON "UserDisplayIcon"("userID", "circleID");

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

-- CreateIndex
CREATE UNIQUE INDEX "Circle_groupID_key" ON "Circle"("groupID");

-- CreateIndex
CREATE INDEX "Circle_ownerID_idx" ON "Circle"("ownerID");

-- CreateIndex
CREATE INDEX "CircleMember_circleID_idx" ON "CircleMember"("circleID");

-- CreateIndex
CREATE UNIQUE INDEX "CircleMember_userID_circleID_key" ON "CircleMember"("userID", "circleID");

-- CreateIndex
CREATE INDEX "CirclePost_circleID_createdAt_idx" ON "CirclePost"("circleID", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CirclePost_authorID_idx" ON "CirclePost"("authorID");

-- CreateIndex
CREATE INDEX "CirclePost_city_createdAt_idx" ON "CirclePost"("city", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CirclePostSignup_postID_idx" ON "CirclePostSignup"("postID");

-- CreateIndex
CREATE INDEX "CirclePostSignup_userID_idx" ON "CirclePostSignup"("userID");

-- CreateIndex
CREATE INDEX "CirclePostSignup_postID_seenByAuthor_idx" ON "CirclePostSignup"("postID", "seenByAuthor");

-- CreateIndex
CREATE UNIQUE INDEX "CirclePostSignup_postID_userID_key" ON "CirclePostSignup"("postID", "userID");

-- CreateIndex
CREATE INDEX "CircleInvitation_circleID_status_idx" ON "CircleInvitation"("circleID", "status");

-- CreateIndex
CREATE INDEX "CircleInvitation_applicantID_idx" ON "CircleInvitation"("applicantID");

-- CreateIndex
CREATE INDEX "CircleInvitationVerifier_verifierID_status_idx" ON "CircleInvitationVerifier"("verifierID", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CircleInvitationVerifier_invitationID_verifierID_key" ON "CircleInvitationVerifier"("invitationID", "verifierID");

-- CreateIndex
CREATE UNIQUE INDEX "TempChat_groupId_key" ON "TempChat"("groupId");

-- CreateIndex
CREATE INDEX "TempChat_status_expiresAt_idx" ON "TempChat"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "TempChat_hostUserId_idx" ON "TempChat"("hostUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TempChatGuest_imUserId_key" ON "TempChatGuest"("imUserId");

-- CreateIndex
CREATE INDEX "TempChatGuest_tempChatId_idx" ON "TempChatGuest"("tempChatId");

-- CreateIndex
CREATE INDEX "EmailVerificationCode_email_purpose_idx" ON "EmailVerificationCode"("email", "purpose");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Friend" ADD CONSTRAINT "Friend_friendID_fkey" FOREIGN KEY ("friendID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendReport" ADD CONSTRAINT "FriendReport_reporterID_fkey" FOREIGN KEY ("reporterID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendReport" ADD CONSTRAINT "FriendReport_targetID_fkey" FOREIGN KEY ("targetID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupReport" ADD CONSTRAINT "GroupReport_reporterID_fkey" FOREIGN KEY ("reporterID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupReport" ADD CONSTRAINT "GroupReport_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_groupID_fkey" FOREIGN KEY ("groupID") REFERENCES "NoteGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_coverMediaID_fkey" FOREIGN KEY ("coverMediaID") REFERENCES "NoteMedia"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteShareLink" ADD CONSTRAINT "NoteShareLink_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteMedia" ADD CONSTRAINT "NoteMedia_noteID_fkey" FOREIGN KEY ("noteID") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteGroup" ADD CONSTRAINT "NoteGroup_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteGroupMembership" ADD CONSTRAINT "NoteGroupMembership_noteID_fkey" FOREIGN KEY ("noteID") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteGroupMembership" ADD CONSTRAINT "NoteGroupMembership_groupID_fkey" FOREIGN KEY ("groupID") REFERENCES "NoteGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendActivity" ADD CONSTRAINT "FriendActivity_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendActivity" ADD CONSTRAINT "FriendActivity_viewerId_fkey" FOREIGN KEY ("viewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendActivity" ADD CONSTRAINT "FriendActivity_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendActivity" ADD CONSTRAINT "FriendActivity_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTag" ADD CONSTRAINT "FriendTag_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTagOnFriend" ADD CONSTRAINT "FriendTagOnFriend_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTagOnFriend" ADD CONSTRAINT "FriendTagOnFriend_tagID_fkey" FOREIGN KEY ("tagID") REFERENCES "FriendTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTagOnFriend" ADD CONSTRAINT "FriendTagOnFriend_friendID_fkey" FOREIGN KEY ("friendID") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingFriendTagOnRequest" ADD CONSTRAINT "PendingFriendTagOnRequest_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingFriendTagOnRequest" ADD CONSTRAINT "PendingFriendTagOnRequest_requestID_fkey" FOREIGN KEY ("requestID") REFERENCES "Friend"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingFriendTagOnRequest" ADD CONSTRAINT "PendingFriendTagOnRequest_tagID_fkey" FOREIGN KEY ("tagID") REFERENCES "FriendTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockerID_fkey" FOREIGN KEY ("blockerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Block" ADD CONSTRAINT "Block_blockedID_fkey" FOREIGN KEY ("blockedID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Activity" ADD CONSTRAINT "Activity_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_initiatorID_fkey" FOREIGN KEY ("initiatorID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_callID_fkey" FOREIGN KEY ("callID") REFERENCES "CallSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallParticipant" ADD CONSTRAINT "CallParticipant_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "ConversationGroup" ADD CONSTRAINT "ConversationGroup_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationGroupMembership" ADD CONSTRAINT "ConversationGroupMembership_groupID_fkey" FOREIGN KEY ("groupID") REFERENCES "ConversationGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "UserPrivacySetting" ADD CONSTRAINT "UserPrivacySetting_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "Wallet" ADD CONSTRAINT "Wallet_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinTransaction" ADD CONSTRAINT "CoinTransaction_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinGift" ADD CONSTRAINT "CoinGift_senderID_fkey" FOREIGN KEY ("senderID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CoinGift" ADD CONSTRAINT "CoinGift_recipientID_fkey" FOREIGN KEY ("recipientID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserCollection" ADD CONSTRAINT "UserCollection_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IconAsset" ADD CONSTRAINT "IconAsset_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IconAsset" ADD CONSTRAINT "IconAsset_createdByID_fkey" FOREIGN KEY ("createdByID") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDisplayIcon" ADD CONSTRAINT "UserDisplayIcon_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserDisplayIcon" ADD CONSTRAINT "UserDisplayIcon_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromCircleID_fkey" FOREIGN KEY ("fromCircleID") REFERENCES "Circle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromCirclePostID_fkey" FOREIGN KEY ("fromCirclePostID") REFERENCES "CirclePost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromInvitationID_fkey" FOREIGN KEY ("fromInvitationID") REFERENCES "CircleInvitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "Circle" ADD CONSTRAINT "Circle_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Circle" ADD CONSTRAINT "Circle_currentIconAssetID_fkey" FOREIGN KEY ("currentIconAssetID") REFERENCES "IconAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirclePost" ADD CONSTRAINT "CirclePost_authorID_fkey" FOREIGN KEY ("authorID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirclePost" ADD CONSTRAINT "CirclePost_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirclePostSignup" ADD CONSTRAINT "CirclePostSignup_postID_fkey" FOREIGN KEY ("postID") REFERENCES "CirclePost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirclePostSignup" ADD CONSTRAINT "CirclePostSignup_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleInvitation" ADD CONSTRAINT "CircleInvitation_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleInvitation" ADD CONSTRAINT "CircleInvitation_applicantID_fkey" FOREIGN KEY ("applicantID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleInvitation" ADD CONSTRAINT "CircleInvitation_inviterID_fkey" FOREIGN KEY ("inviterID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleInvitationVerifier" ADD CONSTRAINT "CircleInvitationVerifier_invitationID_fkey" FOREIGN KEY ("invitationID") REFERENCES "CircleInvitation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleInvitationVerifier" ADD CONSTRAINT "CircleInvitationVerifier_verifierID_fkey" FOREIGN KEY ("verifierID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleInvitationVerifier" ADD CONSTRAINT "CircleInvitationVerifier_addedByID_fkey" FOREIGN KEY ("addedByID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TempChatGuest" ADD CONSTRAINT "TempChatGuest_tempChatId_fkey" FOREIGN KEY ("tempChatId") REFERENCES "TempChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
