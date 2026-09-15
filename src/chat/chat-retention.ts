import { Prisma } from 'src/generated/prisma';

export interface ChatBurnPolicy {
  burnDurationSec?: number | null;
  burnStartedAt?: Date | null;
}

export interface ChatRetentionWindow {
  viewerCutoff: Date | null;
  burnStartedAt: Date | null;
  burnCutoff: Date | null;
}

export function buildChatRetentionWindow(
  policy: ChatBurnPolicy,
  viewerCutoff: Date | null,
  now = new Date(),
): ChatRetentionWindow {
  const seconds =
    typeof policy.burnDurationSec === 'number' && policy.burnDurationSec > 0
      ? policy.burnDurationSec
      : null;
  return {
    viewerCutoff,
    burnStartedAt: seconds ? (policy.burnStartedAt ?? null) : null,
    burnCutoff: seconds ? new Date(now.getTime() - seconds * 1000) : null,
  };
}

export function isChatMessageVisible(
  createdAt: Date,
  window: ChatRetentionWindow,
): boolean {
  if (window.viewerCutoff && createdAt < window.viewerCutoff) return false;
  if (!window.burnCutoff) return true;
  if (window.burnStartedAt && createdAt < window.burnStartedAt) return true;
  return createdAt >= window.burnCutoff;
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

export function chatRetentionWhere(
  window: ChatRetentionWindow,
): Prisma.ChatMessageWhereInput {
  const conditions: Prisma.ChatMessageWhereInput[] = [];
  if (window.viewerCutoff) {
    conditions.push({ createdAt: { gte: window.viewerCutoff } });
  }
  if (window.burnCutoff) {
    conditions.push(
      window.burnStartedAt
        ? {
            OR: [
              { createdAt: { lt: window.burnStartedAt } },
              { createdAt: { gte: window.burnCutoff } },
            ],
          }
        : { createdAt: { gte: window.burnCutoff } },
    );
  }
  return conditions.length > 0 ? { AND: conditions } : {};
}
