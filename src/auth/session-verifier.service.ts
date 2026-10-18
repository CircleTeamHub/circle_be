import { Injectable, Logger } from '@nestjs/common';
import {
  RefreshTokenAudience,
  RefreshTokenRevocationReason,
  SessionRevocationScope,
  UserStatus,
} from 'src/generated/prisma';
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

export type VerifiedSessionIdentity = {
  sessionId: string;
  familyId: string;
  audience: RefreshTokenAudience;
  deviceKey: string | null;
  issuedAtMs: number | null;
};

export type SessionVerification = {
  verdict: SessionVerdict;
  identity: VerifiedSessionIdentity | null;
};

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
  if (
    typeof token.issuedAtMs === 'number' &&
    Number.isFinite(token.issuedAtMs)
  ) {
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
 * Redis revocation markers are an authoritative early deny, but their absence
 * is not an authoritative allow: a restart, eviction, or flush is
 * indistinguishable from "never revoked". PostgreSQL therefore decides every
 * non-revoked Redis result. The account must be ACTIVE and the session row must
 * not be revoked.
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
    return (await this.verifyWithIdentity(token)).verdict;
  }

  async verifyWithIdentity(
    token: VerifiableToken,
  ): Promise<SessionVerification> {
    const state = await this.revocation.checkRevocation(token);
    if (state === 'revoked') return { verdict: 'revoked', identity: null };
    return this.verifyInDatabase(token);
  }

  private async verifyInDatabase(
    token: VerifiableToken,
  ): Promise<SessionVerification> {
    // Every access token we sign carries a string subject; anything else cannot
    // be tied to an account, so it is never let through.
    if (typeof token.sub !== 'string') {
      return { verdict: 'revoked', identity: null };
    }
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
            select: {
              userId: true,
              revokedAt: true,
              revocationReason: true,
              accessRevokedAt: true,
              familyId: true,
              audience: true,
              deviceKey: true,
              accountGeneration: true,
              audienceGeneration: true,
              deviceGeneration: true,
              familyGeneration: true,
            },
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
    if (lookup === null) return { verdict: 'unavailable', identity: null };

    const [user, session] = lookup;
    if (user?.status !== UserStatus.ACTIVE) {
      return { verdict: 'revoked', identity: null };
    }
    const tokenIssuedAt = issuedAtMs(token);
    if (
      user.accessTokensRevokedAt != null &&
      (tokenIssuedAt === null ||
        tokenIssuedAt <= user.accessTokensRevokedAt.getTime())
    ) {
      return { verdict: 'revoked', identity: null };
    }
    if (
      session !== null &&
      (session.userId !== userId ||
        session.accessRevokedAt != null ||
        (session.revokedAt !== null &&
          session.revocationReason !== RefreshTokenRevocationReason.ROTATED))
    ) {
      return { verdict: 'revoked', identity: null };
    }
    if (session === null || sessionId === null) {
      return { verdict: 'active', identity: null };
    }

    const requestedScopes = [
      { scope: SessionRevocationScope.ACCOUNT, scopeKey: '*' },
      { scope: SessionRevocationScope.AUDIENCE, scopeKey: session.audience },
      ...(session.deviceKey
        ? [
            {
              scope: SessionRevocationScope.DEVICE,
              scopeKey: session.deviceKey,
            },
          ]
        : []),
      { scope: SessionRevocationScope.FAMILY, scopeKey: session.familyId },
    ];
    const generations = await this.prisma.sessionScopeGeneration
      .findMany({
        where: { userId, OR: requestedScopes },
        select: {
          scope: true,
          generation: true,
          exemptFamilyId: true,
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Session generation lookup failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      });
    if (generations === null) {
      return { verdict: 'unavailable', identity: null };
    }

    const snapshots: Record<SessionRevocationScope, number> = {
      ACCOUNT: session.accountGeneration,
      AUDIENCE: session.audienceGeneration,
      DEVICE: session.deviceGeneration,
      FAMILY: session.familyGeneration,
    };
    const stale = generations.some(
      ({ scope, generation, exemptFamilyId }) =>
        generation !== snapshots[scope] && exemptFamilyId !== session.familyId,
    );
    if (stale) return { verdict: 'revoked', identity: null };

    return {
      verdict: 'active',
      identity: {
        sessionId,
        familyId: session.familyId,
        audience: session.audience,
        deviceKey: session.deviceKey,
        issuedAtMs: tokenIssuedAt,
      },
    };
  }
}
