import { NotificationType } from 'src/generated/prisma';

/**
 * "互动消息" channel — everything that is not signup management or a system
 * notice: trace comments/replies plus circle verification/invitation events.
 */
export const DISCOVER_NOTIFICATION_TYPES = [
  NotificationType.TRACE_COMMENT,
  NotificationType.COMMENT_REPLY,
  NotificationType.CIRCLE_VERIFICATION_REQUESTED,
  NotificationType.CIRCLE_INVITATION_APPROVED,
  NotificationType.CIRCLE_INVITATION_REJECTED,
  NotificationType.CIRCLE_ADMIN_OVERRIDE_APPROVED,
] as const;

export const PROFILE_NOTIFICATION_TYPES = [NotificationType.SYSTEM] as const;
