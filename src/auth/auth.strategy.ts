import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigEnum } from 'src/enum/config.enum';
import { markSecurityEventLogged } from 'src/logging/handled-errors';
import { createLoggingConfig } from 'src/logging/logging.config';
import {
  getRequestContext,
  setRequestUserId,
} from 'src/logging/request-context';
import { logSecurityEvent } from 'src/logging/security-event.logger';
import type { AuthenticatedUser, JwtPayload } from './types';
import { SessionVerifier } from './session-verifier.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    configService: ConfigService,
    private readonly sessions: SessionVerifier,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>(ConfigEnum.SECRET),
    });
  }

  // Passport attaches whatever this returns to `req.user`.
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const requestContext = getRequestContext();
    // Bind the caller to the request context as early as possible: the access
    // log only learns the user on `finish`, so without this every http_error /
    // security_event / Sentry tag emitted during the request had no userId.
    // The token was validly signed for this subject, so attributing even a
    // revoked-session attempt to it is correct.
    setRequestUserId(payload.sub);

    // Server-side revocation (F-02): reject tokens killed by logout/ban/password
    // change before their natural expiry. SessionVerifier reads the Redis
    // markers and falls back to the database when Redis cannot answer — the
    // same verdict the WebSocket gateways use (see SessionVerifier for rules).
    const verdict = await this.sessions.verify(payload);
    if (verdict === 'revoked') {
      this.rejectRevokedSession(payload, requestContext);
    }
    if (verdict === 'unavailable') {
      // Not a revocation: neither Redis nor the database answered. A 401 would
      // make the app refresh and then clear the session (circle-im
      // services/api/client.ts treats 401/403 as an auth verdict), logging
      // every online user out during a joint outage; 503 fails only this request.
      throw new ServiceUnavailableException('Unable to verify session');
    }
    return {
      userId: payload.sub,
      accountId: payload.accountId,
      role: payload.role,
      audience: payload.aud,
      sessionId: payload.sid,
    };
  }

  private rejectRevokedSession(
    payload: JwtPayload,
    requestContext = getRequestContext(),
  ): never {
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
    markSecurityEventLogged(exception, requestContext);
    throw exception;
  }
}
