import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from 'src/redis/redis.service';
import {
  SESSION_REVOCATION_CHANNEL,
  type SessionRevocationBroadcast,
} from './session-revocation.broadcast';

const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const DURATION_UNITS_IN_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
  y: 365.25 * 24 * 60 * 60 * 1000,
};

export function accessTokenTtlSeconds(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.ceil(raw);
  }
  if (typeof raw !== 'string') return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;

  const normalized = raw.trim().toLowerCase().split(' ').join('');
  let unit = 'ms';
  let amountText = normalized;
  if (normalized.endsWith('ms')) {
    amountText = normalized.slice(0, -2);
  } else {
    const candidateUnit = normalized.charAt(normalized.length - 1);
    if (candidateUnit && candidateUnit in DURATION_UNITS_IN_MS) {
      unit = candidateUnit;
      amountText = normalized.slice(0, -1);
    }
  }
  let dots = 0;
  const validAmount =
    amountText.length > 0 &&
    [...amountText].every((character) => {
      if (character === '.') {
        dots += 1;
        return dots === 1;
      }
      return character >= '0' && character <= '9';
    });
  const amount = validAmount ? Number(amountText) : Number.NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    return DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  }

  const milliseconds = amount * DURATION_UNITS_IN_MS[unit];
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

  /** Revoke every access token issued to this user before now. No-op without Redis. */
  async revokeUser(userId: string): Promise<void> {
    if (!this.redis.isEnabled()) return;
    const revokedAtMs = Date.now();
    await this.redis.setJson(
      this.userKey(userId),
      revokedAtMs,
      this.markerTtlSeconds,
    );
    await this.announce({ kind: 'user', userId, revokedAtMs });
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
  private async announce(event: SessionRevocationBroadcast): Promise<void> {
    try {
      await this.redis.publish(
        SESSION_REVOCATION_CHANNEL,
        JSON.stringify(event),
      );
    } catch (error) {
      this.logger.warn(
        `Failed to announce session revocation: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
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
    if (sid) {
      const marked = await this.redis.getJson<number>(this.sessionKey(sid));
      if (marked) return true;
    }

    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    const issuedAtMs = getIssuedAtMs(payload);
    if (sub && issuedAtMs !== null) {
      const revokedAfter = await this.redis.getJson<number>(this.userKey(sub));
      if (typeof revokedAfter === 'number') {
        // Markers written before millisecond precision used epoch seconds.
        const revokedAtMs =
          revokedAfter < 1_000_000_000_000 ? revokedAfter * 1000 : revokedAfter;
        if (issuedAtMs <= revokedAtMs) return true;
      }
    }

    return false;
  }
}
