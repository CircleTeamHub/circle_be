import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { NotificationModule } from 'src/notification/notification.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { CircleInvitationController } from './circle-invitation.controller';
import { CircleInvitationService } from './circle-invitation.service';

@Module({
  imports: [
    ChatModule,
    RealtimeModule,
    PrivacySettingsModule,
    NotificationModule,
    MembershipPolicyModule,
  ],
  controllers: [CircleInvitationController],
  providers: [
    CircleInvitationService,
    CircleAdmissionPolicy,
    CircleMemberLockService,
  ],
  exports: [CircleInvitationService],
})
export class CircleInvitationModule {}
