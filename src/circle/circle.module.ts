import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CircleInvitationModule } from 'src/circle-invitation/circle-invitation.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { CircleController } from './circle.controller';
import { CircleService } from './circle.service';
import { CircleAdmissionPolicy } from './circle-admission-policy';

@Module({
  imports: [
    OpenimModule,
    RealtimeModule,
    CircleInvitationModule,
    MembershipPolicyModule,
  ],
  controllers: [CircleController],
  providers: [CircleService, CircleAdmissionPolicy],
  exports: [CircleService],
})
export class CircleModule {}
