-- Retire CircleActivity: verification/invitation events now live in Notification
-- (互动消息) and signups are read directly from CirclePostSignup (报名管理).
INSERT INTO "Notification" (
    "id",
    "content",
    "read",
    "type",
    "toUserID",
    "fromUserID",
    "fromCircleID",
    "fromInvitationID",
    "createdAt",
    "updatedAt"
)
SELECT
    activity."id",
    '',
    activity."readAt" IS NOT NULL,
    CASE activity."type"
        WHEN 'VERIFICATION_REQUESTED' THEN 'CIRCLE_VERIFICATION_REQUESTED'::"NotificationType"
        WHEN 'INVITATION_ALL_APPROVED' THEN 'CIRCLE_INVITATION_APPROVED'::"NotificationType"
        WHEN 'INVITATION_SLOT_REJECTED' THEN 'CIRCLE_INVITATION_REJECTED'::"NotificationType"
        WHEN 'ADMIN_OVERRIDE_APPROVED' THEN 'CIRCLE_ADMIN_OVERRIDE_APPROVED'::"NotificationType"
    END,
    activity."viewerID",
    activity."actorID",
    activity."circleID",
    activity."invitationID",
    activity."createdAt",
    COALESCE(activity."readAt", activity."createdAt")
FROM "CircleActivity" activity
WHERE activity."type" IN (
    'VERIFICATION_REQUESTED',
    'INVITATION_ALL_APPROVED',
    'INVITATION_SLOT_REJECTED',
    'ADMIN_OVERRIDE_APPROVED'
)
ON CONFLICT ("id") DO NOTHING;

DROP TABLE "CircleActivity";

DROP TYPE "CircleActivityType";
