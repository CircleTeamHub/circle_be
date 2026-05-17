import { Global, Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Global()
@Module({
  imports: [RealtimeModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
