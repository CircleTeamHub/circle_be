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
 * 圈子铃铛（CirclePlazaScreen 右上角 / 消息页飞机）—— 担保验证、入圈审批、收到圈子邀请、
 * 活动结束与认可、被移出圈子、圈子解散。圈子的事一律走这里，不进消息页的「通知」。
 * 有人发帖不进这里：发帖只点亮飞机 tab 的红点（见 circle-plaza-update.query）。
 * 「报名管理」未读走 CirclePostSignup.seenByAuthor，不在这张表里，
 * 由 signupUnread 单独统计。
 */
export const CIRCLE_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.CIRCLE_VERIFICATION_REQUESTED,
  NotificationType.CIRCLE_INVITATION_APPROVED,
  NotificationType.CIRCLE_INVITATION_REJECTED,
  NotificationType.CIRCLE_ADMIN_OVERRIDE_APPROVED,
  NotificationType.CIRCLE_POST_AUTO_ENDED,
  NotificationType.CIRCLE_POST_COLLABORATION_RECOGNIZED,
  NotificationType.CIRCLE_INVITATION_RECEIVED,
  NotificationType.CIRCLE_MEMBER_REMOVED,
  NotificationType.CIRCLE_DISSOLVED,
] as const);

/**
 * 群聊知会：本人被移出独立群聊、独立群聊被解散。只在站内出现（不写推送 outbox）——
 * 被移出不需要本人做什么，推送只是打扰；独立群任何成员都能拉好友进群，反复拉踢还能刷别人的推送。
 */
export const GROUP_NOTICE_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.GROUP_MEMBER_REMOVED,
  NotificationType.GROUP_DISSOLVED,
] as const);

/**
 * 点赞只在站内出现（铃铛列表 + 红点），不写推送 outbox。
 *
 * 厂商通道把点赞这类「社交动态」归进资讯营销类：每台设备每天只放行 2~5 条，超出直接丢。
 * 每个赞都推，会把评论、回复、@ 这些要人回应的推送一起挤掉。站内列表按动态合并展示。
 */
export const IN_APP_ONLY_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.TRACE_LIKE,
  NotificationType.PROFILE_LIKE,
] as const);

const IN_APP_ONLY_NOTIFICATION_TYPE_SET: ReadonlySet<NotificationType> =
  new Set(IN_APP_ONLY_NOTIFICATION_TYPES);

export function isInAppOnlyNotification(type: NotificationType): boolean {
  return IN_APP_ONLY_NOTIFICATION_TYPE_SET.has(type);
}

/**
 * 受「圈子通知设置 → 离线提醒」门控的类型 —— 圈子铃铛那几种，再加上报名通知。
 *
 * 门控面比铃铛面宽一项：CIRCLE_POST_SIGNUP_CREATED 的未读走
 * CirclePostSignup.seenByAuthor、不进铃铛，但它照样是一条把人吵醒的圈子推送，
 * 用户关掉离线提醒之后不该再收到。
 *
 * 之前投递处写的是 `type.startsWith('CIRCLE_')`：门控面跟着枚举**名字**漂移，
 * 新增一个恰好叫 CIRCLE_ 开头、却不该被这个开关关掉的类型就会被静默吞掉。
 * 显式列出来，再由 spec 钉住「CIRCLE_NOTIFICATION_TYPES 的每一项都在门控面里」，
 * 两张表就不会各走各的。
 */
export const CIRCLE_OFFLINE_PUSH_TYPES = compactNotificationTypes([
  ...CIRCLE_NOTIFICATION_TYPES,
  NotificationType.CIRCLE_POST_SIGNUP_CREATED,
] as const);

const CIRCLE_OFFLINE_PUSH_TYPE_SET: ReadonlySet<NotificationType> = new Set(
  CIRCLE_OFFLINE_PUSH_TYPES,
);

/** 这条通知的离线推送是否受用户的圈子开关门控。 */
export function isCircleOfflinePushGated(
  type: NotificationType | null | undefined,
): boolean {
  return type != null && CIRCLE_OFFLINE_PUSH_TYPE_SET.has(type);
}

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
  NotificationType.GROUP_ADMISSION,
  ...MOMENT_NOTIFICATION_TYPES,
  ...CIRCLE_NOTIFICATION_TYPES,
] as const);

export const PROFILE_NOTIFICATION_TYPES = compactNotificationTypes([
  NotificationType.SYSTEM,
] as const);

/**
 * 铃铛/入口的域。moments、circle 是两个铃铛；notice 是消息页的「通知」(圈子以外的知会，
 * 好友申请/入群申请有自己的处理页「新的朋友」，不在列表里)，group / system 是它的两个分类。
 */
export const NOTIFICATION_DOMAINS = [
  'moments',
  'circle',
  'notice',
  'group',
  'system',
] as const;

export type NotificationDomain = (typeof NOTIFICATION_DOMAINS)[number];

const NOTIFICATION_DOMAIN_TYPES: Record<
  NotificationDomain,
  readonly NotificationType[]
> = {
  moments: MOMENT_NOTIFICATION_TYPES,
  circle: CIRCLE_NOTIFICATION_TYPES,
  notice: [
    ...MOMENT_NOTIFICATION_TYPES,
    ...GROUP_NOTICE_NOTIFICATION_TYPES,
    ...PROFILE_NOTIFICATION_TYPES,
  ],
  group: GROUP_NOTICE_NOTIFICATION_TYPES,
  system: PROFILE_NOTIFICATION_TYPES,
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
