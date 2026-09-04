import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigEnum } from 'src/enum/config.enum';
import { NotificationModule } from 'src/notification/notification.module';
import { RedisModule } from 'src/redis/redis.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { SensitiveWordModule } from 'src/sensitive-word/sensitive-word.module';
import { UploadModule } from 'src/upload/upload.module';
import { SupportModule } from 'src/support/support.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatCircleSyncService } from './chat-circle-sync.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatMediaService } from './chat-media.service';
import { ChatPushService } from './chat-push.service';
import { ChatSystemMessageService } from './chat-system-message.service';
import { ChatBurnSweeperService } from './chat-burn-sweeper.service';
import { ChatPresenceRegistry } from './chat-presence.registry';
import { ChatService } from './chat.service';
import { ChatSupportRechargeProcessor } from './chat-support-recharge.processor';

// PrismaService 与 SessionRevocationService 来自 @Global 模块(Prisma/Auth);
// JwtModule 仿 RealtimeModule 各自注册(verify 用);敏感词/上传服务显式 import。
@Module({
  imports: [
    NotificationModule,
    RedisModule,
    SensitiveWordModule,
    PrivacySettingsModule,
    UploadModule,
    SupportModule,
    MembershipPolicyModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>(ConfigEnum.SECRET),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [ChatController],
  providers: [
    ChatGateway,
    ChatService,
    ChatBroadcastService,
    ChatCircleSyncService,
    ChatMediaService,
    ChatPushService,
    ChatSystemMessageService,
    ChatBurnSweeperService,
    ChatPresenceRegistry,
    ChatSupportRechargeProcessor,
    CircleMemberLockService,
  ],
  exports: [
    ChatService,
    ChatBroadcastService,
    ChatCircleSyncService,
    ChatSystemMessageService,
  ],
})
export class ChatModule {}
