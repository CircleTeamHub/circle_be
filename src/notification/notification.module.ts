import { Global, Module } from '@nestjs/common';
import { ModerationModule } from 'src/moderation/moderation.module';
import { RedisModule } from 'src/redis/redis.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationController } from './notification.controller';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationPublicController } from './notification-public.controller';
import { NotificationPushService } from './notification-push.service';
import { ApnsVoipClient } from './apns-voip.client';
import { NotificationService } from './notification.service';
import { NotificationPushOutboxProcessor } from './notification-push-outbox.processor';
import { NotificationRetentionCleanup } from './notification-retention.cleanup';

@Global()
@Module({
  imports: [RealtimeModule, RedisModule, ModerationModule],
  controllers: [
    NotificationPublicController,
    NotificationController,
    NotificationAdminController,
  ],
  providers: [
    NotificationService,
    NotificationPushService,
    ApnsVoipClient,
    NotificationPushOutboxProcessor,
    NotificationRetentionCleanup,
  ],
  exports: [NotificationService, NotificationPushService, ApnsVoipClient],
})
export class NotificationModule {}
