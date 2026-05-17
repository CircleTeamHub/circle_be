import { Global, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ConfigEnum } from 'src/enum/config.enum';
import { JwtStrategy } from './auth.strategy';
import { CaslAbilityService } from './casl-ability.service';
import { RefreshTokenService } from './refresh-token.service';
import { OpenimModule } from 'src/openim/openim.module';

@Global()
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => {
        // `@nestjs/jwt` types `expiresIn` as `number | StringValue`; widen
        // through the literal cast since ConfigService returns generic string.
        const expiresIn = (configService.get<string>('JWT_EXPIRES_IN') ??
          '1h') as unknown as number;
        return {
          secret: configService.get<string>(ConfigEnum.SECRET),
          signOptions: { expiresIn },
        };
      },
      inject: [ConfigService],
    }),
    OpenimModule,
  ],
  providers: [
    AuthService,
    RefreshTokenService,
    JwtStrategy,
    CaslAbilityService,
  ],
  controllers: [AuthController],
  // RefreshTokenService is exported so other modules (e.g. UserService when
  // BAN/DELETE happens) can revoke a user's sessions without going through
  // AuthService.
  exports: [CaslAbilityService, RefreshTokenService],
})
export class AuthModule {}
