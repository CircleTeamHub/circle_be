ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'GROUP_ADMISSION';
ALTER TABLE "ChatConversation" ADD COLUMN "cardJoinEnabled" BOOLEAN NOT NULL DEFAULT true, ADD COLUMN "joinApprovalRequired" BOOLEAN NOT NULL DEFAULT true;
CREATE TABLE "GroupAdmission" (
 "id" TEXT NOT NULL PRIMARY KEY, "conversationID" TEXT NOT NULL, "applicantID" TEXT NOT NULL, "inviterID" TEXT, "qrToken" TEXT,
 "kind" TEXT NOT NULL, "status" TEXT NOT NULL, "reason" TEXT NOT NULL DEFAULT '', "expiresAt" TIMESTAMP(3) NOT NULL,
 "acceptedAt" TIMESTAMP(3), "decidedByID" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "GroupAdmission_kind_check" CHECK ("kind" IN ('INVITE','QR','APPLICATION')),
 CONSTRAINT "GroupAdmission_status_check" CHECK ("status" IN ('INVITED','PENDING','JOINED','REJECTED','DECLINED','EXPIRED'))
);
CREATE INDEX "GroupAdmission_conversationID_status_createdAt_idx" ON "GroupAdmission"("conversationID","status","createdAt");
CREATE INDEX "GroupAdmission_applicantID_updatedAt_idx" ON "GroupAdmission"("applicantID","updatedAt");
CREATE UNIQUE INDEX "GroupAdmission_active_applicant_key" ON "GroupAdmission"("conversationID","applicantID") WHERE "status" IN ('INVITED','PENDING');
CREATE TABLE "GroupAdmissionDelivery" (
 "id" TEXT NOT NULL PRIMARY KEY, "admissionID" TEXT NOT NULL REFERENCES "GroupAdmission"("id"), "recipientID" TEXT NOT NULL, "actorID" TEXT NOT NULL,
 "event" TEXT NOT NULL, "deliveredAt" TIMESTAMP(3), "attempts" INTEGER NOT NULL DEFAULT 0, "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "GroupAdmissionDelivery_admissionID_recipientID_event_key" ON "GroupAdmissionDelivery"("admissionID","recipientID","event");
CREATE INDEX "GroupAdmissionDelivery_deliveredAt_nextAttemptAt_idx" ON "GroupAdmissionDelivery"("deliveredAt","nextAttemptAt");
ALTER TABLE "Notification" ADD COLUMN "fromGroupAdmissionID" TEXT REFERENCES "GroupAdmission"("id");
CREATE INDEX "Notification_fromGroupAdmissionID_idx" ON "Notification"("fromGroupAdmissionID");

ALTER TYPE "CircleInvitationStatus" ADD VALUE IF NOT EXISTS 'INVITED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CIRCLE_INVITATION_RECEIVED';
ALTER TABLE "CircleInvitation" ADD COLUMN "consentNoticeDeliveredAt" TIMESTAMP(3), ADD COLUMN "consentNoticeAttempts" INTEGER NOT NULL DEFAULT 0, ADD COLUMN "consentNoticeRequired" BOOLEAN NOT NULL DEFAULT false;
