import { Global, Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationController } from './notification.controller';
import { NotificationPushService } from './notification-push.service';
import { NotificationService } from './notification.service';
import { NotificationPushOutboxProcessor } from './notification-push-outbox.processor';

@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationPushService,
    NotificationPushOutboxProcessor,
  ],
  exports: [NotificationService, NotificationPushService],
})
export class NotificationModule {}
