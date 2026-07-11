import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CircleInvitationModule } from 'src/circle-invitation/circle-invitation.module';
import { CircleController } from './circle.controller';
import { CircleService } from './circle.service';

@Module({
  imports: [OpenimModule, RealtimeModule, CircleInvitationModule],
  controllers: [CircleController],
  providers: [CircleService],
  exports: [CircleService],
})
export class CircleModule {}
