import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CircleInvitationController } from './circle-invitation.controller';
import { CircleInvitationService } from './circle-invitation.service';

@Module({
  imports: [OpenimModule, RealtimeModule],
  controllers: [CircleInvitationController],
  providers: [CircleInvitationService],
})
export class CircleInvitationModule {}
