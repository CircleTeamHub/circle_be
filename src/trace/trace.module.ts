import { Module } from '@nestjs/common';
import { TraceController } from './trace.controller';
import { TraceService } from './trace.service';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { AvatarFrameModule } from 'src/avatar-frame/avatar-frame.module';

@Module({
  imports: [
    NotificationModule,
    RealtimeModule,
    PrivacySettingsModule,
    AvatarFrameModule,
  ],
  controllers: [TraceController],
  providers: [TraceService],
})
export class TraceModule {}
