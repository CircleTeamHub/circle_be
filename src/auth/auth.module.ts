import { Global, Logger, Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PassportModule } from '@nestjs/passport';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ConfigEnum } from 'src/enum/config.enum';
import { JwtStrategy } from './auth.strategy';
import { CaslAbilityService } from './casl-ability.service';
import { RefreshTokenService } from './refresh-token.service';
import { RefreshTokenCleanup } from './refresh-token.cleanup';
import { SessionRevocationService } from './session-revocation.service';
import { EmailVerificationService } from './email-verification.service';
import { MAILER } from './mailer/mailer.interface';
import { ConsoleMailer } from './mailer/console.mailer';
import { SmtpMailer } from './mailer/smtp.mailer';
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
    RefreshTokenCleanup,
    SessionRevocationService,
    EmailVerificationService,
    {
      // 真实投递 vs 开发态自动切换（#82）：SMTP_HOST 存在即用 SmtpMailer
      // （凭据齐备由 env.validation 兜底），否则回落 ConsoleMailer。生产环境
      // 落在 Console 路径时用 error 级日志砸出来 —— 那意味着没有任何用户能
      // 收到验证码，注册/验证码登录整条链路都是坏的。不直接 fail boot：
      // 让「填上 SMTP_* 四个变量」成为唯一动作，而不是先救活部署再配邮箱。
      provide: MAILER,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        if (configService.get<string>('SMTP_HOST')) {
          return new SmtpMailer(configService);
        }
        if (configService.get<string>('NODE_ENV') === 'production') {
          new Logger('AuthModule').error(
            'SMTP_HOST is not configured in production — verification codes ' +
              'are only printed to the server console and NO user can ' +
              'register or log in by code. Set SMTP_HOST/SMTP_USER/SMTP_PASS ' +
              '(and optionally SMTP_PORT/SMTP_SECURE/MAIL_FROM).',
          );
        }
        return new ConsoleMailer();
      },
    },
    JwtStrategy,
    CaslAbilityService,
  ],
  controllers: [AuthController],
  // RefreshTokenService is exported so other modules (e.g. UserService when
  // BAN/DELETE happens) can revoke a user's sessions without going through
  // AuthService. SessionRevocationService is exported so the realtime gateway
  // can run the same revocation check on WebSocket auth that HTTP runs.
  exports: [CaslAbilityService, RefreshTokenService, SessionRevocationService],
})
export class AuthModule {}
