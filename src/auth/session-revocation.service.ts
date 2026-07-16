import { Injectable } from '@nestjs/common';
import { RedisService } from 'src/redis/redis.service';

type RevocablePayload = { sub?: unknown; sid?: unknown; iat?: unknown };

/**
 * Server-side revocation for stateless access tokens (F-02).
 *
 * The JWT strategy is otherwise stateless, so a logout / ban / password-change
 * couldn't invalidate an already-issued access token until it expired (~1h).
 * This keeps two kinds of revocation markers in Redis, checked on every
 * authenticated request:
 *
 * - per-user `revokedAfter` epoch — kills every token issued before it
 *   (logout-all, ban, password change, refresh-token reuse);
 * - per-session flag — kills one session's access token (single logout).
 *
 * **Fail-open by design.** Redis is optional in this deployment; when it is
 * off or unreachable, `isRevoked` returns false and auth degrades to the
 * token's own TTL (exactly the prior behavior) instead of locking everyone
 * out. So enabling Redis strengthens revocation; losing it never breaks login.
 */
@Injectable()
export class SessionRevocationService {
  /**
   * Markers must outlive any valid access token. 24h is a safe upper bound over
   * any sane `JWT_EXPIRES_IN`, so a marker never expires while a token it should
   * still be blocking is alive.
   */
  private static readonly MARKER_TTL_SECONDS = 24 * 60 * 60;

  constructor(private readonly redis: RedisService) {}

  private userKey(userId: string): string {
    return `authrev:u:${userId}`;
  }

  private sessionKey(sessionId: string): string {
    return `authrev:s:${sessionId}`;
  }

  /** Revoke every access token issued to this user before now. No-op without Redis. */
  async revokeUser(userId: string): Promise<void> {
    if (!this.redis.isEnabled()) return;
    const nowSeconds = Math.floor(Date.now() / 1000);
    await this.redis.setJson(
      this.userKey(userId),
      nowSeconds,
      SessionRevocationService.MARKER_TTL_SECONDS,
    );
  }

  /** Revoke a single session's access token (single logout / kill one session). */
  async revokeSession(sessionId: string): Promise<void> {
    if (!this.redis.isEnabled()) return;
    await this.redis.setJson(
      this.sessionKey(sessionId),
      1,
      SessionRevocationService.MARKER_TTL_SECONDS,
    );
  }

  /**
   * Whether this access token has been revoked. Fail-open: with Redis off or
   * erroring, returns false so auth degrades to the token's own TTL rather than
   * locking everyone out.
   */
  async isRevoked(payload: RevocablePayload): Promise<boolean> {
    if (!this.redis.isEnabled()) return false;

    const sid = typeof payload.sid === 'string' ? payload.sid : null;
    if (sid) {
      const marked = await this.redis.getJson<number>(this.sessionKey(sid));
      if (marked) return true;
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    const iat = typeof payload.iat === 'number' ? payload.iat : null;
    if (sub && iat !== null) {
      const revokedAfter = await this.redis.getJson<number>(this.userKey(sub));
      // Strict `<`: a token minted at/after the revoke instant (i.e. a fresh
      // re-login) survives; only tokens issued before it are killed.
      if (typeof revokedAfter === 'number' && iat < revokedAfter) return true;
    }

    return false;
  }
}
