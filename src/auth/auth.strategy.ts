import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigEnum } from 'src/enum/config.enum';
import { RefreshTokenRevocationReason, UserStatus } from 'src/generated/prisma';
import { markSecurityEventLogged } from 'src/logging/handled-errors';
import { createLoggingConfig } from 'src/logging/logging.config';
import { setRequestUserId } from 'src/logging/request-context';
import { logSecurityEvent } from 'src/logging/security-event.logger';
import { PrismaService } from 'src/prisma/prisma.service';
import type { AuthenticatedUser, JwtPayload } from './types';
import { SessionRevocationService } from './session-revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    configService: ConfigService,
    private readonly revocation: SessionRevocationService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>(ConfigEnum.SECRET),
    });
  }

  // Passport attaches whatever this returns to `req.user`.
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    // Bind the caller to the request context as early as possible: the access
    // log only learns the user on `finish`, so without this every http_error /
    // security_event / Sentry tag emitted during the request had no userId.
    // The token was validly signed for this subject, so attributing even a
    // revoked-session attempt to it is correct.
    setRequestUserId(payload.sub);

    // Server-side revocation (F-02): reject tokens killed by logout/ban/password
    // change before their natural expiry.
    //
    // Why the database fallback: Redis is optional in production —
    // `.env.production.example` ships REDIS_REQUIRED=false — and this check used
    // to fail open, so whenever Redis was unset, down, or timing out, a banned
    // or logged-out user's access token kept working until it expired. When
    // Redis cannot answer (`unknown`) we now verify the account and the session
    // row in the database; a database failure rejects the request rather than
    // guessing. The Redis-available path is unchanged and adds no query.
    const state = await this.revocation.checkRevocation(payload);
    if (state === 'revoked') {
      this.rejectRevokedSession(payload);
    }
    if (state === 'unknown') {
      await this.assertActiveInDatabase(payload);
    }
    return {
      userId: payload.sub,
      accountId: payload.accountId,
      role: payload.role,
      audience: payload.aud,
      sessionId: payload.sid,
    };
  }

  /**
   * The database view of revocation, used only when Redis cannot answer.
   *
   * - The account must still be ACTIVE (ban / deletion).
   * - The session row (`sid` is the RefreshToken primary key) must not be
   *   revoked. ROTATED is not a revocation: refresh rotation retires the row id
   *   while the session lives on under a new sid, and the Redis path writes no
   *   marker for it either. A missing row passes on account status alone —
   *   RefreshTokenCleanup deletes expired rows, and the refresh TTL may be
   *   configured shorter than the access TTL.
   *
   * Known gap vs. the Redis path: logout-all / password change / token-family
   * reuse revoke each family's live row, but earlier ROTATED rows keep their
   * ROTATED reason, so an access token still carrying such an older sid stays
   * valid here until it expires (<= JWT_EXPIRES_IN). Closing it needs a
   * per-user "revoked after" timestamp in the database.
   */
  private async assertActiveInDatabase(payload: JwtPayload): Promise<void> {
    const [user, session] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: payload.sub },
        select: { status: true },
      }),
      payload.sid
        ? this.prisma.refreshToken.findUnique({
            where: { id: payload.sid },
            select: { userId: true, revokedAt: true, revocationReason: true },
          })
        : Promise.resolve(null),
    ]).catch((error: unknown) => {
      this.logger.warn(
        `Revocation fallback lookup failed; rejecting the request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new UnauthorizedException('Unable to verify session');
    });

    const sessionRevoked =
      session !== null &&
      (session.userId !== payload.sub ||
        (session.revokedAt !== null &&
          session.revocationReason !== RefreshTokenRevocationReason.ROTATED));
    if (user?.status !== UserStatus.ACTIVE || sessionRevoked) {
      this.rejectRevokedSession(payload);
    }
  }

  private rejectRevokedSession(payload: JwtPayload): never {
    // A revoked-but-valid token being replayed is the one 401 worth its own
    // security event: it means a session that was explicitly killed is
    // still in someone's hands.
    logSecurityEvent(this.logger, {
      enabled: this.loggingConfig.securityLogOn,
      securityEvent: 'session_revoked_token_used',
      statusCode: 401,
      userId: payload.sub,
      metadata: { sessionId: payload.sid, audience: payload.aud },
    });
    // That event *is* the security record for this rejection; mark it so
    // AllExceptionFilter does not add a generic `auth_unauthorized` on top.
    const exception = new UnauthorizedException('Session revoked');
    markSecurityEventLogged(exception);
    throw exception;
  }
}
