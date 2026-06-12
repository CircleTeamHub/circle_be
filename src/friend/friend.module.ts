import { Module } from '@nestjs/common';
import { NotificationModule } from 'src/notification/notification.module';
import { OpenimModule } from 'src/openim/openim.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { FriendController } from './friend.controller';
import { FriendSyncOutboxProcessor } from './friend-sync-outbox.processor';
import { FriendService } from './friend.service';

@Module({
  imports: [
    RealtimeModule,
    NotificationModule,
    OpenimModule,
    PrivacySettingsModule,
  ],
  controllers: [FriendController],
  providers: [FriendService, FriendSyncOutboxProcessor],
  exports: [FriendService],
})
export class FriendModule {}
