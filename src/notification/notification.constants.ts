import { NotificationType } from 'src/generated/prisma';

/**
 * "互动消息" channel (the notification-bell list) — trace comments/replies plus
 * circle verification/invitation events.
 *
 * Friend-request events (RECEIVED/ACCEPTED/REJECTED) are intentionally NOT here:
 * they have a dedicated "新的朋友" inbox (FriendActivity) with its own unread
 * badge, so surfacing them in the bell too is redundant. They are still created
 * and pushed (createFriendRequestNotification / notification-push) — this list
 * only governs what the bell shows and counts.
 */
export const DISCOVER_NOTIFICATION_TYPES = [
  NotificationType.TRACE_LIKE,
  NotificationType.TRACE_COMMENT,
  NotificationType.COMMENT_REPLY,
  NotificationType.CIRCLE_VERIFICATION_REQUESTED,
  NotificationType.CIRCLE_INVITATION_APPROVED,
  NotificationType.CIRCLE_INVITATION_REJECTED,
  NotificationType.CIRCLE_ADMIN_OVERRIDE_APPROVED,
  NotificationType.CIRCLE_POST_SIGNUP_CREATED,
  NotificationType.CIRCLE_POST_AUTO_ENDED,
  NotificationType.PROFILE_LIKE,
] as const;

export const PROFILE_NOTIFICATION_TYPES = [NotificationType.SYSTEM] as const;
