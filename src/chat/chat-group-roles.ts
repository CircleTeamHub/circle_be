import type { ChatMemberRole } from 'src/generated/prisma';

/**
 * 群管理的角色判定(纯函数,两种群共用)。
 *
 * - 圈子群:角色真值在 CircleMember(OWNER/ADMIN/MEMBER + ACTIVE)。
 * - 独立群聊:群主 = ChatConversation.ownerID,管理员 = ChatMember.role。
 *
 * 词汇约定:mute = 免打扰(ChatMember.muted,只影响推送),silence = 禁言
 * (silencedAt / silencedUntil,不能发言)。别把两者混用。
 */
export type GroupRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/** 禁言时长边界:最短 1 分钟,最长 30 天;null = 直到解除。 */
export const SILENCE_DURATION_MIN_SEC = 60;
export const SILENCE_DURATION_MAX_SEC = 30 * 86_400;

/** 群日志单页条数:默认 50,上限 100。 */
export const GROUP_EVENTS_PAGE_DEFAULT = 50;
export const GROUP_EVENTS_PAGE_MAX = 100;

export interface StandaloneSeatLike {
  userID: string;
  role: ChatMemberRole;
  leftAt: Date | null;
}

export interface CircleMembershipLike {
  role: GroupRole;
  status: string;
}

export interface SilenceStateLike {
  silencedAt: Date | null;
  silencedUntil: Date | null;
}

/** 独立群聊:座位 + 群主字段 → 角色;不在座返回 null。 */
export function standaloneGroupRole(
  ownerID: string | null,
  seat: StandaloneSeatLike | null | undefined,
): GroupRole | null {
  if (!seat || seat.leftAt) return null;
  if (ownerID !== null && ownerID === seat.userID) return 'OWNER';
  return seat.role === 'ADMIN' ? 'ADMIN' : 'MEMBER';
}

/** 圈子群:CircleMember 行 → 角色;非 ACTIVE 一律视为不在群。 */
export function circleGroupRole(
  membership: CircleMembershipLike | null | undefined,
): GroupRole | null {
  if (!membership || membership.status !== 'ACTIVE') return null;
  return membership.role;
}

export function isGroupManager(role: GroupRole | null): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/**
 * 谁能动谁:群主可动管理员与普通成员;管理员只能动普通成员;谁都动不了群主。
 * 同级(管理员对管理员)也不行 —— 否则两个管理员可以互相禁言/互踢。
 */
export function canManageGroupTarget(
  actor: GroupRole | null,
  target: GroupRole | null,
): boolean {
  if (!actor || !target) return false;
  if (actor === 'OWNER') return target !== 'OWNER';
  if (actor === 'ADMIN') return target === 'MEMBER';
  return false;
}

/** 座位是否处于禁言:silencedAt 非空,且(直到解除 或 未到期)。 */
export function isSeatSilenced(
  seat: SilenceStateLike,
  now: Date = new Date(),
): boolean {
  if (!seat.silencedAt) return false;
  return (
    seat.silencedUntil === null || seat.silencedUntil.getTime() > now.getTime()
  );
}

/** 到期时间的对外表示:未禁言 → null;禁言中且到期 → ISO;直到解除 → null。 */
export function silencedUntilOf(
  seat: SilenceStateLike,
  now: Date = new Date(),
): string | null {
  if (!isSeatSilenced(seat, now)) return null;
  return seat.silencedUntil ? seat.silencedUntil.toISOString() : null;
}

export function isValidSilenceDuration(durationSec: number | null): boolean {
  if (durationSec === null) return true;
  return (
    Number.isInteger(durationSec) &&
    durationSec >= SILENCE_DURATION_MIN_SEC &&
    durationSec <= SILENCE_DURATION_MAX_SEC
  );
}
