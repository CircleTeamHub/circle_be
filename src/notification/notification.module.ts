import { Global, Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationController } from './notification.controller';
import { NotificationPublicController } from './notification-public.controller';
import { NotificationPushService } from './notification-push.service';
import { NotificationService } from './notification.service';

@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationPublicController, NotificationController],
  providers: [NotificationService, NotificationPushService],
  exports: [NotificationService, NotificationPushService],
})
export class NotificationModule {}
