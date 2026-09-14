import { Injectable, Logger } from '@nestjs/common';
import { RefreshTokenRevocationReason, UserStatus } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionRevocationService } from './session-revocation.service';

/**
 * - `active`: the access token may be used;
 * - `revoked`: logout / ban / password change killed it. Callers answer 401
 *   (HTTP) or close with the revoked frame (WebSocket), which clients treat as
 *   a terminal auth outcome;
 * - `unavailable`: neither Redis nor the database could answer. This is not a
 *   revocation — callers fail only this request / connection in a way clients
 *   retry (HTTP 503, WebSocket 1013), so a joint Redis + database blip does not
 *   log every online user out.
 */
export type SessionVerdict = 'active' | 'revoked' | 'unavailable';

/**
 * The claims the check reads. Both the HTTP `JwtPayload` and the realtime
 * gateway's loosely typed payload fit.
 */
export type VerifiableToken = {
  sub?: unknown;
  sid?: unknown;
  iat?: unknown;
  issuedAtMs?: unknown;
};

function issuedAtMs(token: VerifiableToken): number | null {
  if (typeof token.issuedAtMs === 'number' && Number.isFinite(token.issuedAtMs)) {
    return token.issuedAtMs;
  }
  if (typeof token.iat === 'number' && Number.isFinite(token.iat)) {
    return token.iat * 1000;
  }
  return null;
}

/**
 * The single answer to "may this access token still be used?", shared by
 * JwtStrategy and the WebSocket gateways so no entry point quietly fails open.
 *
 * Redis revocation markers are authoritative and cost no query. Redis is
 * optional in production (`.env.production.example` ships
 * REDIS_REQUIRED=false), so when it is disabled or cannot answer, the database
 * decides: the account must be ACTIVE and the session row must not be revoked.
 *
 * - ROTATED is not a revocation: refresh rotation retires the row id while the
 *   session lives on under a new sid, and the Redis path writes no marker for
 *   it either.
 * - A missing session row passes on account status alone: RefreshTokenCleanup
 *   deletes expired rows, and the refresh TTL may be configured shorter than
 *   the access TTL.
 *
 * The user-level accessTokensRevokedAt timestamp closes the gap where a rotated
 * refresh-token row remains marked ROTATED after logout-all/password change or
 * token-family reuse. It is checked before the session-row fallback so Redis
 * outages do not turn a broad revocation into a fail-open path.
 */
@Injectable()
export class SessionVerifier {
  private readonly logger = new Logger(SessionVerifier.name);

  constructor(
    private readonly revocation: SessionRevocationService,
    private readonly prisma: PrismaService,
  ) {}

  async verify(token: VerifiableToken): Promise<SessionVerdict> {
    const state = await this.revocation.checkRevocation(token);
    if (state !== 'unknown') return state;
    return this.verifyInDatabase(token);
  }

  private async verifyInDatabase(
    token: VerifiableToken,
  ): Promise<SessionVerdict> {
    // Every access token we sign carries a string subject; anything else cannot
    // be tied to an account, so it is never let through.
    if (typeof token.sub !== 'string') return 'revoked';
    const userId = token.sub;
    const sessionId = typeof token.sid === 'string' ? token.sid : null;

    const lookup = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { status: true, accessTokensRevokedAt: true },
      }),
      sessionId
        ? this.prisma.refreshToken.findUnique({
            where: { id: sessionId },
            select: { userId: true, revokedAt: true, revocationReason: true },
          })
        : Promise.resolve(null),
    ]).then(
      (rows) => rows,
      (error: unknown) => {
        this.logger.warn(
          `Session verification fallback lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      },
    );
    if (lookup === null) return 'unavailable';

    const [user, session] = lookup;
    if (user?.status !== UserStatus.ACTIVE) return 'revoked';
    const tokenIssuedAt = issuedAtMs(token);
    if (
      user.accessTokensRevokedAt != null &&
      (tokenIssuedAt === null ||
        tokenIssuedAt <= user.accessTokensRevokedAt.getTime())
    ) {
      return 'revoked';
    }
    if (
      session !== null &&
      (session.userId !== userId ||
        (session.revokedAt !== null &&
          session.revocationReason !== RefreshTokenRevocationReason.ROTATED))
    ) {
      return 'revoked';
    }
    return 'active';
  }
}
