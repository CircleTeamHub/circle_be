import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CallCleanup } from './call.cleanup';
import { CallController } from './call.controller';
import { CallService } from './call.service';
import { CallWebhookController } from './call.webhook.controller';
import { LiveKitCallService } from './livekit.service';

@Module({
  imports: [ChatModule, RealtimeModule, PrivacySettingsModule],
  controllers: [CallController, CallWebhookController],
  providers: [CallService, LiveKitCallService, CallCleanup],
  exports: [CallService],
})
export class CallModule {}
