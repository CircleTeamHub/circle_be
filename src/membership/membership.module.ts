import { Module } from '@nestjs/common';
import { MembershipController } from './membership.controller';
import { MembershipService } from './membership.service';
import { MembershipPolicyModule } from './membership-policy.module';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { MembershipAdminController } from './membership-admin.controller';
import { MembershipAdminService } from './membership-admin.service';

@Module({
  imports: [MembershipPolicyModule, NotificationModule, RealtimeModule],
  controllers: [MembershipController, MembershipAdminController],
  providers: [MembershipService, MembershipAdminService],
  exports: [MembershipService],
})
export class MembershipModule {}
