import { ExtractJwt, Strategy } from 'passport-jwt';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigEnum } from 'src/enum/config.enum';
import type { AuthenticatedUser, JwtPayload } from './types';
import { SessionRevocationService } from './session-revocation.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
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
    // Server-side revocation (F-02): reject tokens killed by logout/ban/password
    // change before their natural expiry. Fail-open when Redis is unavailable.
    if (await this.revocation.isRevoked(payload)) {
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
