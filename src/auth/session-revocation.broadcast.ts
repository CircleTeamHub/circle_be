/**
 * Wire format for the session-revocation backplane (F-02, realtime half).
 *
 * Writing a revocation marker to Redis stops the *next* authenticated request,
 * but an already-established WebSocket holds no such checkpoint — it would keep
 * receiving pushes until its JWT expired (~1h). Revocations are therefore also
 * published on this channel so every instance can close the sockets it holds
 * for that user/session, including the instances that did not process the ban.
 *
 * Kept in its own module (importing nothing) so both the producer (`auth`) and
 * the consumer (`realtime`) can depend on it without an import cycle.
 */

/**
 * Single global channel. Revocations are rare compared to realtime events, so
 * the per-user channel sharding used by `circle:realtime:user:*` would buy
 * nothing here; every instance has to inspect the message anyway.
 */
export const SESSION_REVOCATION_CHANNEL = 'circle:realtime:revoke';

export type SessionRevocationBroadcast =
  /** Every token this user was issued at or before `revokedAtMs` is dead. */
  | { kind: 'user'; userId: string; revokedAtMs: number }
  /** One session (one device) is dead; the user's other devices survive. */
  | { kind: 'session'; sessionId: string };

/**
 * Parses a message off the backplane. Anything malformed or foreign returns
 * null rather than throwing — a bad publish must never take down a subscriber
 * shared by every connected socket on the instance.
 */
export function parseSessionRevocationBroadcast(
  message: string,
): SessionRevocationBroadcast | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed as Record<string, unknown>;

  if (candidate.kind === 'user') {
    const { userId, revokedAtMs } = candidate;
    if (typeof userId !== 'string' || userId.length === 0) return null;
    if (typeof revokedAtMs !== 'number' || !Number.isFinite(revokedAtMs)) {
      return null;
    }
    return { kind: 'user', userId, revokedAtMs };
  }

  if (candidate.kind === 'session') {
    const { sessionId } = candidate;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    return { kind: 'session', sessionId };
  }

  return null;
}
