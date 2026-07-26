import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from 'src/redis/redis.service';
import {
  SESSION_REVOCATION_CHANNEL,
  type SessionRevocationBroadcast,
} from './session-revocation.broadcast';
import { parseDurationMilliseconds } from 'src/utils/duration';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

export function accessTokenTtlSeconds(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.ceil(raw);
  }
  if (typeof raw !== 'string') return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const milliseconds = parseDurationMilliseconds(raw);
  if (milliseconds === null) return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  return Math.max(1, Math.ceil(milliseconds / 1000));
}

type RevocablePayload = {
  sub?: unknown;
  sid?: unknown;
  iat?: unknown;
  issuedAtMs?: unknown;
};

function getIssuedAtMs(payload: RevocablePayload): number | null {
  if (typeof payload.issuedAtMs === 'number') return payload.issuedAtMs;
  if (typeof payload.iat === 'number') return payload.iat * 1000;
  return null;
}

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
  private readonly logger = new Logger(SessionRevocationService.name);
  private readonly markerTtlSeconds: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.markerTtlSeconds = accessTokenTtlSeconds(
      config.get<string | number>('JWT_EXPIRES_IN') ?? '1h',
    );
  }

  private userKey(userId: string): string {
    return `authrev:u:${userId}`;
  }

  private sessionKey(sessionId: string): string {
    return `authrev:s:${sessionId}`;
  }

  revocationExpiresAt(revokedAtMs: number): Date {
    return new Date(revokedAtMs + this.markerTtlSeconds * 1000);
  }

  /** Revoke every access token issued to this user before now. No-op without Redis. */
  async revokeUser(userId: string): Promise<void> {
    await this.revokeUserAt(userId, Date.now());
  }

  /**
   * Persist a revocation marker at the original security-event timestamp.
   * Returns false when Redis is disabled or the socket-close broadcast needs
   * retry; marker write errors reject so durable callers can retry them too.
   */
  async revokeUserAt(userId: string, revokedAtMs: number): Promise<boolean> {
    if (!this.redis.isEnabled()) return false;
    const markerStored = await this.redis.setNumericMax(
      this.userKey(userId),
      revokedAtMs,
      this.markerTtlSeconds,
    );
    if (!markerStored) return false;
    return this.announce({ kind: 'user', userId, revokedAtMs });
  }

  /** Revoke a single session's access token (single logout / kill one session). */
  async revokeSession(sessionId: string): Promise<void> {
    if (!this.redis.isEnabled()) return;
    await this.redis.setJson(
      this.sessionKey(sessionId),
      1,
      this.markerTtlSeconds,
    );
    await this.announce({ kind: 'session', sessionId });
  }

  /**
   * Tells every instance to drop the WebSockets this revocation just killed.
   * The marker above only gates the *next* request; a live socket has no such
   * checkpoint, so without this a banned user keeps receiving pushes until the
   * JWT expires.
   *
   * Best-effort by design: a publish failure still leaves the marker written,
   * so HTTP stays protected and the socket dies at token expiry — the same
   * degradation as running without Redis. Never let it fail the revocation.
   */
  private async announce(event: SessionRevocationBroadcast): Promise<boolean> {
    try {
      return await this.redis.publish(
        SESSION_REVOCATION_CHANNEL,
        JSON.stringify(event),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to announce session revocation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return false;
    }
  }

  /**
   * Whether this access token has been revoked. Fail-open: with Redis off or
   * erroring, returns false so auth degrades to the token's own TTL rather than
   * locking everyone out.
   */
  async isRevoked(payload: RevocablePayload): Promise<boolean> {
    if (!this.redis.isEnabled()) return false;

    const sid = typeof payload.sid === 'string' ? payload.sid : null;
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    const issuedAtMs = getIssuedAtMs(payload);

    const keys: string[] = [];
    if (sid) keys.push(this.sessionKey(sid));
    if (sub && issuedAtMs !== null) keys.push(this.userKey(sub));
    if (keys.length === 0) return false;

    const markers = await this.redis.getJsonMany<number>(keys);
    let markerIndex = 0;
    if (sid && markers[markerIndex++]) return true;

    if (sub && issuedAtMs !== null) {
      const revokedAfter = markers[markerIndex];
      if (typeof revokedAfter !== 'number') return false;
      // Markers written before millisecond precision used epoch seconds.
      const revokedAtMs =
        revokedAfter < 1_000_000_000_000 ? revokedAfter * 1000 : revokedAfter;
      if (issuedAtMs <= revokedAtMs) return true;
    }

    return false;
  }
}
