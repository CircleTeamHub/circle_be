import { Module } from '@nestjs/common';
import { NotificationModule } from 'src/notification/notification.module';
import { ChatModule } from 'src/chat/chat.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CreditModule } from 'src/credit/credit.module';
import { FriendController } from './friend.controller';
import { FriendReportAdminController } from './friend-report-admin.controller';
import { FriendReportAdminService } from './friend-report-admin.service';
import { FriendChatReplayOutboxProcessor } from './friend-chat-replay-outbox.processor';
import { FriendService } from './friend.service';
import { AvatarFrameModule } from 'src/avatar-frame/avatar-frame.module';

@Module({
  imports: [
    RealtimeModule,
    NotificationModule,
    ChatModule,
    PrivacySettingsModule,
    CreditModule,
    AvatarFrameModule,
  ],
  controllers: [FriendController, FriendReportAdminController],
  providers: [
    FriendService,
    FriendReportAdminService,
    FriendChatReplayOutboxProcessor,
  ],
  exports: [FriendService],
})
export class FriendModule {}
