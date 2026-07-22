import { Global, Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationController } from './notification.controller';
import { NotificationPublicController } from './notification-public.controller';
import { NotificationPushService } from './notification-push.service';
import { NotificationService } from './notification.service';
import { NotificationPushOutboxProcessor } from './notification-push-outbox.processor';
import { NotificationRetentionCleanup } from './notification-retention.cleanup';

@Global()
@Module({
  imports: [RealtimeModule, RedisModule],
  controllers: [NotificationPublicController, NotificationController],
  providers: [
    NotificationService,
    NotificationPushService,
    NotificationPushOutboxProcessor,
    NotificationRetentionCleanup,
  ],
  exports: [NotificationService, NotificationPushService],
})
export class NotificationModule {}
