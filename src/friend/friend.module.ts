import { Module } from '@nestjs/common';
import { NotificationModule } from 'src/notification/notification.module';
import { OpenimModule } from 'src/openim/openim.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CreditModule } from 'src/credit/credit.module';
import { FriendController } from './friend.controller';
import { FriendReportAdminController } from './friend-report-admin.controller';
import { FriendReportAdminService } from './friend-report-admin.service';
import { FriendSyncOutboxProcessor } from './friend-sync-outbox.processor';
import { FriendService } from './friend.service';

@Module({
  imports: [
    RealtimeModule,
    NotificationModule,
    OpenimModule,
    PrivacySettingsModule,
    CreditModule,
  ],
  controllers: [FriendController, FriendReportAdminController],
  providers: [
    FriendService,
    FriendReportAdminService,
    FriendSyncOutboxProcessor,
  ],
  exports: [FriendService],
})
export class FriendModule {}
