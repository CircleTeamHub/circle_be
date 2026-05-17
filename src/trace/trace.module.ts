import { Module } from '@nestjs/common';
import { TraceController } from './trace.controller';
import { TraceService } from './trace.service';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';

@Module({
  imports: [NotificationModule, RealtimeModule],
  controllers: [TraceController],
  providers: [TraceService],
})
export class TraceModule {}
