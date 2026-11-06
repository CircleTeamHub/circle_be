import type {
  ChatAbnormalMemberDto,
  ChatAbnormalMemberReason,
} from './chat.types';

/**
 * 群管理「异常成员」的判定(纯函数):长期未登录、信誉值低。
 *
 * 天数档与前端筛选项逐值镜像(前端 test/group-abnormal-members-contract.test.js 守住),
 * 加档两边一起改;服务端只认这几档,不接受任意天数。
 */
export const ABNORMAL_INACTIVE_DAY_OPTIONS = [7, 30, 90] as const;
export type AbnormalInactiveDays =
  (typeof ABNORMAL_INACTIVE_DAY_OPTIONS)[number];
export const ABNORMAL_INACTIVE_DAYS_DEFAULT: AbnormalInactiveDays = 30;

/** 低于该分即「信誉值低」:与信誉页「需要提升」档(0–59)同一口径。 */
export const LOW_CREDIT_SCORE_THRESHOLD = 60;

const DAY_MS = 86_400_000;

export interface AbnormalMemberCandidate {
  userId: string;
  lastOnline: Date | null;
  createdAt: Date;
  creditScore: number;
  /** 隐私页「显示在线时间」;没有设置行 = 默认开。 */
  shareOnlineStatus: boolean;
}

export function inactiveCutoff(inactiveDays: number, now: Date): Date {
  return new Date(now.getTime() - inactiveDays * DAY_MS);
}

/**
 * 判定一位成员;都不命中返回 null。
 *
 * - 未登录:最近在线早于截止时刻;从没记过 lastOnline 的按注册时间算。
 *   本人关掉了「显示在线时间」就不参与这一项 —— 隐私页承诺过关掉后不再向任何人
 *   透出最近在线,「N 天未登录」同样是在线时间。
 * - 信誉值低:只在命中时回分数,没命中的人分数不外露(信誉值原本只有本人可见)。
 */
export function classifyAbnormalMember(
  candidate: AbnormalMemberCandidate,
  cutoff: Date,
): ChatAbnormalMemberDto | null {
  const lastActive = candidate.lastOnline ?? candidate.createdAt;
  const inactive =
    candidate.shareOnlineStatus && lastActive.getTime() < cutoff.getTime();
  const lowCredit = candidate.creditScore < LOW_CREDIT_SCORE_THRESHOLD;
  const reasons: ChatAbnormalMemberReason[] = [];
  if (inactive) reasons.push('INACTIVE');
  if (lowCredit) reasons.push('LOW_CREDIT');
  if (reasons.length === 0) return null;
  return {
    userId: candidate.userId,
    reasons,
    lastActiveAt:
      inactive && candidate.lastOnline
        ? candidate.lastOnline.toISOString()
        : null,
    creditScore: lowCredit ? candidate.creditScore : null,
  };
}

const compare = (a: number, b: number) => (a < b ? -1 : a > b ? 1 : 0);

/** 排序:两项都命中的在前;再按最久没上线、信誉值最低;最后按 userId 稳定。 */
export function compareAbnormalMembers(
  a: ChatAbnormalMemberDto,
  b: ChatAbnormalMemberDto,
): number {
  const activeAt = (member: ChatAbnormalMemberDto) => {
    if (!member.reasons.includes('INACTIVE')) return Number.POSITIVE_INFINITY;
    // 没有在线记录 = 比任何一次记录都久。
    return member.lastActiveAt ? Date.parse(member.lastActiveAt) : 0;
  };
  const credit = (member: ChatAbnormalMemberDto) =>
    member.creditScore ?? Number.POSITIVE_INFINITY;
  return (
    compare(b.reasons.length, a.reasons.length) ||
    compare(activeAt(a), activeAt(b)) ||
    compare(credit(a), credit(b)) ||
    a.userId.localeCompare(b.userId)
  );
}
