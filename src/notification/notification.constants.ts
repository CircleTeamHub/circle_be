import { NotificationType } from 'src/generated/prisma';

export const DISCOVER_NOTIFICATION_TYPES = [
  NotificationType.TRACE_COMMENT,
  NotificationType.COMMENT_REPLY,
] as const;

export const PROFILE_NOTIFICATION_TYPES = [
  NotificationType.SYSTEM,
] as const;
