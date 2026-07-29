import { Module } from '@nestjs/common';
import { MembershipController } from './membership.controller';
import { MembershipService } from './membership.service';
import { MembershipPolicyModule } from './membership-policy.module';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { IconModule } from 'src/icon/icon.module';
import { MembershipAdminController } from './membership-admin.controller';
import { MembershipAdminService } from './membership-admin.service';
import { MembershipProgramAdminController } from './membership-program-admin.controller';
import { FancyNumberModule } from 'src/fancy-number/fancy-number.module';
import { AvatarFrameModule } from 'src/avatar-frame/avatar-frame.module';

@Module({
  imports: [
    MembershipPolicyModule,
    NotificationModule,
    RealtimeModule,
    IconModule,
    FancyNumberModule,
    AvatarFrameModule,
  ],
  controllers: [
    MembershipController,
    MembershipAdminController,
    MembershipProgramAdminController,
  ],
  providers: [MembershipService, MembershipAdminService],
  exports: [MembershipService],
})
export class MembershipModule {}
