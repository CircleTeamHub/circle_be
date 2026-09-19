import { Prisma } from 'src/generated/prisma';

export interface ChatBurnPolicy {
  burnDurationSec?: number | null;
  burnStartedAt?: Date | null;
}

/**
 * 查看者自己的全局阅后即焚设置(UserPrivacySetting)。
 *
 * cutoff 与 startedAt 必须成对传递 —— 只给下沿而不给开启时间,就是把开关打开
 * 之前的全部历史一次性隐藏。这两个值曾经分开传,查看者侧因此长期缺少会话级
 * 焚毁早就有的那道开启边界。
 */
export interface ChatViewerPolicy {
  /** 窗口下沿:早于它的消息对本人不再出现。null = 未开启,不做任何过滤。 */
  cutoff: Date | null;
  /** 开启时间:早于它发出的消息不受这个窗口约束。 */
  startedAt: Date | null;
}

/** 查看者未开启全局阅后即焚(或调用方显式不施加查看者保留期)。 */
export const NO_VIEWER_RETENTION: ChatViewerPolicy = Object.freeze({
  cutoff: null,
  startedAt: null,
});

export interface ChatRetentionWindow {
  viewerCutoff: Date | null;
  viewerStartedAt: Date | null;
  burnStartedAt: Date | null;
  burnCutoff: Date | null;
}

export function buildChatRetentionWindow(
  policy: ChatBurnPolicy,
  viewer: ChatViewerPolicy,
  now = new Date(),
): ChatRetentionWindow {
  const seconds =
    typeof policy.burnDurationSec === 'number' && policy.burnDurationSec > 0
      ? policy.burnDurationSec
      : null;
  return {
    viewerCutoff: viewer.cutoff,
    // 开启时间只在窗口生效时有意义,和 burnStartedAt 同一个处理方式。
    viewerStartedAt: viewer.cutoff ? viewer.startedAt : null,
    burnStartedAt: seconds ? (policy.burnStartedAt ?? null) : null,
    burnCutoff: seconds ? new Date(now.getTime() - seconds * 1000) : null,
  };
}

/**
 * 一侧保留窗口的判定:没有下沿就不过滤;开启之前发出的一律放行;其余按下沿比。
 * 查看者侧和会话焚毁侧共用它,两边的语义因此不会再各自漂移。
 */
function isVisibleInWindow(
  createdAt: Date,
  startedAt: Date | null,
  cutoff: Date | null,
): boolean {
  if (!cutoff) return true;
  if (startedAt && createdAt < startedAt) return true;
  return createdAt >= cutoff;
}

export function isChatMessageVisible(
  createdAt: Date,
  window: ChatRetentionWindow,
): boolean {
  return (
    isVisibleInWindow(createdAt, window.viewerStartedAt, window.viewerCutoff) &&
    isVisibleInWindow(createdAt, window.burnStartedAt, window.burnCutoff)
  );
}

export function effectiveBurnDurationForMessage(
  policy: ChatBurnPolicy,
  createdAt: Date,
): number | null {
  const seconds =
    typeof policy.burnDurationSec === 'number' && policy.burnDurationSec > 0
      ? policy.burnDurationSec
      : null;
  if (!seconds) return null;
  if (policy.burnStartedAt && createdAt < policy.burnStartedAt) return null;
  return seconds;
}

/** isVisibleInWindow 的 SQL 对应物,同样两侧共用。 */
function windowWhere(
  startedAt: Date | null,
  cutoff: Date,
): Prisma.ChatMessageWhereInput {
  return startedAt
    ? {
        OR: [{ createdAt: { lt: startedAt } }, { createdAt: { gte: cutoff } }],
      }
    : { createdAt: { gte: cutoff } };
}

export function chatRetentionWhere(
  window: ChatRetentionWindow,
): Prisma.ChatMessageWhereInput {
  const conditions: Prisma.ChatMessageWhereInput[] = [];
  if (window.viewerCutoff) {
    conditions.push(windowWhere(window.viewerStartedAt, window.viewerCutoff));
  }
  if (window.burnCutoff) {
    conditions.push(windowWhere(window.burnStartedAt, window.burnCutoff));
  }
  return conditions.length > 0 ? { AND: conditions } : {};
}
