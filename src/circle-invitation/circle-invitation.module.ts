import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { CircleInvitationController } from './circle-invitation.controller';
import { CircleInvitationService } from './circle-invitation.service';

@Module({
  imports: [OpenimModule, RealtimeModule, PrivacySettingsModule],
  controllers: [CircleInvitationController],
  providers: [CircleInvitationService],
})
export class CircleInvitationModule {}
