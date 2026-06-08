-- AlterEnum: route circle verification/invitation events through the
-- interaction-message (Notification) channel instead of CircleActivity.
ALTER TYPE "NotificationType" ADD VALUE 'CIRCLE_VERIFICATION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'CIRCLE_INVITATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'CIRCLE_INVITATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'CIRCLE_ADMIN_OVERRIDE_APPROVED';

-- AlterTable: carry the circle / invitation context on the notification row.
ALTER TABLE "Notification" ADD COLUMN     "fromCircleID" TEXT,
ADD COLUMN     "fromInvitationID" TEXT;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromCircleID_fkey" FOREIGN KEY ("fromCircleID") REFERENCES "Circle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_fromInvitationID_fkey" FOREIGN KEY ("fromInvitationID") REFERENCES "CircleInvitation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
