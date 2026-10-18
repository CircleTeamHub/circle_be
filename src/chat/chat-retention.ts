import { Prisma } from 'src/generated/prisma';

export interface ChatBurnPolicy {
  burnDurationSec?: number | null;
  burnStartedAt?: Date | null;
}

/** Legacy read-window shape, retained for callers during the sender-policy rollout. */
export interface ChatViewerPolicy {
  cutoff: Date | null;
  startedAt: Date | null;
}
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

/** Legacy shared/viewer windows never delete another author's messages. */
export function buildChatRetentionWindow(
  _policy: ChatBurnPolicy,
  _viewer: ChatViewerPolicy,
  _now = new Date(),
): ChatRetentionWindow {
  return {
    viewerCutoff: null,
    viewerStartedAt: null,
    burnStartedAt: null,
    burnCutoff: null,
  };
}

/** Visibility depends only on the expiry fixed by the author on first send. */
export function isChatMessageVisible(
  _createdAt: Date,
  _window: ChatRetentionWindow,
  burnExpiresAt?: Date | null,
): boolean {
  return !burnExpiresAt || burnExpiresAt.getTime() > Date.now();
}

export function chatRetentionWhere(
  _window: ChatRetentionWindow,
): Prisma.ChatMessageWhereInput {
  return {
    AND: [
      { OR: [{ burnExpiresAt: null }, { burnExpiresAt: { gt: new Date() } }] },
    ],
  };
}
