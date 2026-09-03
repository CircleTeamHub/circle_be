import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigEnum } from 'src/enum/config.enum';
import { createLoggingConfig } from 'src/logging/logging.config';
import { setRequestUserId } from 'src/logging/request-context';
import { logSecurityEvent } from 'src/logging/security-event.logger';
import type { AuthenticatedUser, JwtPayload } from './types';
import { SessionRevocationService } from './session-revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);
  private readonly loggingConfig = createLoggingConfig();

  constructor(
    configService: ConfigService,
    private readonly revocation: SessionRevocationService,
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
    // change before their natural expiry. Fail-open when Redis is unavailable.
    if (await this.revocation.isRevoked(payload)) {
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
      throw new UnauthorizedException('Session revoked');
    }
    return {
      userId: payload.sub,
      accountId: payload.accountId,
      role: payload.role,
      audience: payload.aud,
      sessionId: payload.sid,
    };
  }
}
