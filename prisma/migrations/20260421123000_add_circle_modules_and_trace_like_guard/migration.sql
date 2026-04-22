-- CreateEnum
CREATE TYPE "CirclePostStatus" AS ENUM ('ACTIVE', 'DELETED');

-- CreateEnum
CREATE TYPE "CircleMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "CircleMemberStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');

-- CreateEnum
CREATE TYPE "CircleCategory" AS ENUM (
    'LIFE',
    'FOOD',
    'SPORTS',
    'SOCIAL',
    'GAMING',
    'PHOTOGRAPHY',
    'WORK',
    'TRADE',
    'CUSTOM'
);

-- CreateEnum
CREATE TYPE "CircleInvitationStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED',
    'ADMIN_APPROVED'
);

-- CreateEnum
CREATE TYPE "CircleInvitationVerifierStatus" AS ENUM (
    'PENDING',
    'APPROVED',
    'REJECTED'
);

-- CreateEnum
CREATE TYPE "CircleActivityType" AS ENUM (
    'VERIFICATION_REQUESTED',
    'VERIFICATION_APPROVED',
    'VERIFICATION_REJECTED',
    'INVITATION_ALL_APPROVED',
    'INVITATION_SLOT_REJECTED',
    'ADMIN_OVERRIDE_APPROVED'
);

-- AlterTable
ALTER TABLE "User"
ADD COLUMN "vipLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "creditScore" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN "fancyNumber" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Circle" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "avatarUrl" TEXT,
    "ownerID" TEXT NOT NULL,
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
    "status" "CirclePostStatus" NOT NULL DEFAULT 'ACTIVE',
    "authorID" TEXT NOT NULL,
    "circleID" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CirclePost_pkey" PRIMARY KEY ("id")
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
CREATE TABLE "CircleActivity" (
    "id" TEXT NOT NULL,
    "circleID" TEXT NOT NULL,
    "invitationID" TEXT,
    "viewerID" TEXT NOT NULL,
    "actorID" TEXT NOT NULL,
    "type" "CircleActivityType" NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CircleActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Circle_groupID_key" ON "Circle"("groupID");

-- CreateIndex
CREATE INDEX "Circle_ownerID_idx" ON "Circle"("ownerID");

-- CreateIndex
CREATE UNIQUE INDEX "CircleMember_userID_circleID_key" ON "CircleMember"("userID", "circleID");

-- CreateIndex
CREATE INDEX "CircleMember_circleID_idx" ON "CircleMember"("circleID");

-- CreateIndex
CREATE INDEX "CirclePost_circleID_createdAt_idx" ON "CirclePost"("circleID", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CirclePost_authorID_idx" ON "CirclePost"("authorID");

-- CreateIndex
CREATE INDEX "CirclePost_city_createdAt_idx" ON "CirclePost"("city", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "CircleInvitation_circleID_status_idx" ON "CircleInvitation"("circleID", "status");

-- CreateIndex
CREATE INDEX "CircleInvitation_applicantID_idx" ON "CircleInvitation"("applicantID");

-- CreateIndex
CREATE UNIQUE INDEX "CircleInvitation_pending_unique_idx"
ON "CircleInvitation"("circleID", "applicantID")
WHERE "status" = 'PENDING';

-- CreateIndex
CREATE UNIQUE INDEX "CircleInvitationVerifier_invitationID_verifierID_key" ON "CircleInvitationVerifier"("invitationID", "verifierID");

-- CreateIndex
CREATE INDEX "CircleInvitationVerifier_verifierID_status_idx" ON "CircleInvitationVerifier"("verifierID", "status");

-- CreateIndex
CREATE INDEX "CircleActivity_viewerID_readAt_idx" ON "CircleActivity"("viewerID", "readAt");

-- CreateIndex
CREATE INDEX "CircleActivity_invitationID_idx" ON "CircleActivity"("invitationID");

-- CreateIndex
CREATE UNIQUE INDEX "traceLikeStat_traceID_userID_key" ON "traceLikeStat"("traceID", "userID");

-- AddForeignKey
ALTER TABLE "Circle" ADD CONSTRAINT "Circle_ownerID_fkey" FOREIGN KEY ("ownerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_userID_fkey" FOREIGN KEY ("userID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleMember" ADD CONSTRAINT "CircleMember_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirclePost" ADD CONSTRAINT "CirclePost_authorID_fkey" FOREIGN KEY ("authorID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CirclePost" ADD CONSTRAINT "CirclePost_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "CircleActivity" ADD CONSTRAINT "CircleActivity_circleID_fkey" FOREIGN KEY ("circleID") REFERENCES "Circle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleActivity" ADD CONSTRAINT "CircleActivity_invitationID_fkey" FOREIGN KEY ("invitationID") REFERENCES "CircleInvitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleActivity" ADD CONSTRAINT "CircleActivity_viewerID_fkey" FOREIGN KEY ("viewerID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CircleActivity" ADD CONSTRAINT "CircleActivity_actorID_fkey" FOREIGN KEY ("actorID") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
