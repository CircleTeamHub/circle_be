import { Logger, Module } from '@nestjs/common';
import { UserModule } from './user/user.module';
import { ConfigModule } from '@nestjs/config';
import * as dotenv from 'dotenv';
import { ScheduleModule } from '@nestjs/schedule';
// ThrottlerModule.forRoot is registered globally so @Throttle metadata works,
// but the ThrottlerGuard is applied per-controller (see TempChatController),
// not via a global APP_GUARD — rate limiting stays scoped to temp-chat.
import { ThrottlerModule } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { WinstonLoggingModule } from './logging/winston-logging.module';
import { ModerationModule } from './moderation/moderation.module';
import { PrismaModule } from './prisma/prisma.module';
import { UploadModule } from './upload/upload.module';
import { FriendModule } from './friend/friend.module';
import { CoinModule } from './coin/coin.module';
import { CollectionModule } from './collection/collection.module';
import { NoteModule } from './note/note.module';
import { MembershipModule } from './membership/membership.module';
import { MallModule } from './mall/mall.module';
import { CircleModule } from './circle/circle.module';
import { CirclePlazaModule } from './circle-plaza/circle-plaza.module';
import { CircleInvitationModule } from './circle-invitation/circle-invitation.module';
import { TraceModule } from './trace/trace.module';
import { IconModule } from './icon/icon.module';
import { LikeModule } from './like/like.module';
import { RealtimeModule } from './realtime/realtime.module';
import { NotificationModule } from './notification/notification.module';
import { ConversationGroupModule } from './conversation-group/conversation-group.module';
import { TempChatModule } from './temp-chat/temp-chat.module';
import { createEnvValidationSchema } from './config/env.validation';
import { GroupModule } from './group/group.module';
import { CallModule } from './call/call.module';
import { PrivacySettingsModule } from './privacy/privacy-settings.module';
import { RedisModule } from './redis/redis.module';
import { CreditModule } from './credit/credit.module';
import { AdminUserModule } from './admin-user/admin-user.module';
import { FancyNumberModule } from './fancy-number/fancy-number.module';
import { GroupExpansionModule } from './group-expansion/group-expansion.module';
import { SupportModule } from './support/support.module';
import { QrModule } from './qr/qr.module';
import { DashboardModule } from './admin-dashboard/dashboard.module';
import { AvatarFrameModule } from './avatar-frame/avatar-frame.module';
import { AdminCommunityModule } from './admin-community/admin-community.module';
import { SensitiveWordModule } from './sensitive-word/sensitive-word.module';
import { ChatModule } from './chat/chat.module';
import { MetricsModule } from './metrics/metrics.module';
import { ReferralModule } from './referral/referral.module';

const nodeEnv = process.env.NODE_ENV || 'development';
const envFilePath = `.env.${nodeEnv}`;

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath,
      load: [() => dotenv.config({ path: '.env', quiet: true })],
      validationSchema: createEnvValidationSchema(),
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    RedisModule,
    PrismaModule,
    UserModule,
    AuthModule,
    WinstonLoggingModule,
    ModerationModule,
    UploadModule,
    FriendModule,
    CoinModule,
    MembershipModule,
    MallModule,
    CollectionModule,
    NoteModule,
    CircleModule,
    IconModule,
    LikeModule,
    CirclePlazaModule,
    CircleInvitationModule,
    TraceModule,
    RealtimeModule,
    NotificationModule,
    ConversationGroupModule,
    TempChatModule,
    GroupModule,
    PrivacySettingsModule,
    CreditModule,
    CallModule,
    AdminUserModule,
    FancyNumberModule,
    GroupExpansionModule,
    SupportModule,
    DashboardModule,
    AvatarFrameModule,
    AdminCommunityModule,
    SensitiveWordModule,
    ChatModule,
    MetricsModule,
    ReferralModule,
    QrModule,
  ],
  controllers: [],
  providers: [Logger],
  exports: [Logger],
})
export class AppModule {}
