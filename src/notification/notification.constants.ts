import { NotificationType } from 'src/generated/prisma';

function compactNotificationTypes(
  values: readonly (NotificationType | undefined)[],
): NotificationType[] {
  return values.filter((value): value is NotificationType => Boolean(value));
}

/**
 * 朋友圈铃铛（MomentsScreen 右上角）—— 别人对「我」和「我的动态」的互动。
 * 圈子相关的事件一律不进这里，否则朋友圈铃铛会替圈子报红点。
 */
export const MOMENT_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.TRACE_LIKE,
  NotificationType.TRACE_COMMENT,
  NotificationType.COMMENT_REPLY,
  NotificationType.TRACE_MENTION,
  NotificationType.PROFILE_LIKE,
] as const);

/**
 * 圈子铃铛（CirclePlazaScreen 右上角）—— 担保验证、入圈审批、圈子帖动态。
 * 「报名管理」未读走 CirclePostSignup.seenByAuthor，不在这张表里，
 * 由 signupUnread 单独统计。
 */
export const CIRCLE_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.CIRCLE_VERIFICATION_REQUESTED,
  NotificationType.CIRCLE_INVITATION_APPROVED,
  NotificationType.CIRCLE_INVITATION_REJECTED,
  NotificationType.CIRCLE_ADMIN_OVERRIDE_APPROVED,
  NotificationType.CIRCLE_POST_PUBLISHED,
  NotificationType.CIRCLE_POST_SIGNUP_CREATED,
  NotificationType.CIRCLE_POST_AUTO_ENDED,
  NotificationType.CIRCLE_POST_COLLABORATION_RECOGNIZED,
] as const);

/**
 * 好友申请事件：留在通知表里（推送渠道 + durable record 需要），但两个铃铛都不收 ——
 * 「新的朋友」收件箱才是它的规范 UI，未读走 contactsUnread。
 */
export const FRIEND_REQUEST_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.FRIEND_REQUEST_RECEIVED,
  NotificationType.FRIEND_REQUEST_ACCEPTED,
  NotificationType.FRIEND_REQUEST_REJECTED,
] as const);

/**
 * "互动消息" channel — 上面三组的并集，即所有非 profile 域的通知。
 * 仍然是 list/read-all 的默认全集；按域收窄请用 notificationTypesForDomain。
 */
export const DISCOVER_NOTIFICATION_TYPES = compactNotificationTypes([
  ...FRIEND_REQUEST_NOTIFICATION_TYPES,
  ...MOMENT_NOTIFICATION_TYPES,
  ...CIRCLE_NOTIFICATION_TYPES,
] as const);

export const PROFILE_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.SYSTEM,
] as const);

export const NOTIFICATION_DOMAINS = ['moments', 'circle'] as const;

export type NotificationDomain = (typeof NOTIFICATION_DOMAINS)[number];

const NOTIFICATION_DOMAIN_TYPES: Record<
  NotificationDomain,
  readonly NotificationType[]
> = {
  moments: MOMENT_NOTIFICATION_TYPES,
  circle: CIRCLE_NOTIFICATION_TYPES,
};

/**
 * 域 -> 通知类型白名单。不传域时退回全集，保持老客户端（不带 domain 查询参数）
 * 的行为不变。
 */
export function notificationTypesForDomain(
  domain?: NotificationDomain | null,
): readonly NotificationType[] {
  return domain
    ? NOTIFICATION_DOMAIN_TYPES[domain]
    : DISCOVER_NOTIFICATION_TYPES;
}
