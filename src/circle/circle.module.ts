import { Module } from '@nestjs/common';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CircleInvitationModule } from 'src/circle-invitation/circle-invitation.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { ChatModule } from 'src/chat/chat.module';
import { CircleController } from './circle.controller';
import { CircleService } from './circle.service';
import { CircleAdmissionPolicy } from './circle-admission-policy';
import { CircleMemberLockService } from './circle-member-lock';

@Module({
  imports: [
    RealtimeModule,
    CircleInvitationModule,
    MembershipPolicyModule,
    ChatModule,
  ],
  controllers: [CircleController],
  providers: [CircleService, CircleAdmissionPolicy, CircleMemberLockService],
  exports: [CircleService],
})
export class CircleModule {}
