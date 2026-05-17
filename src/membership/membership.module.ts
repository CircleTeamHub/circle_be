import { Module } from '@nestjs/common';
import { MembershipController } from './membership.controller';
import { MembershipService } from './membership.service';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NotificationModule } from 'src/notification/notification.module';

@Module({
  imports: [RealtimeModule, NotificationModule],
  controllers: [MembershipController],
  providers: [MembershipService],
  exports: [MembershipService],
})
export class MembershipModule {}
