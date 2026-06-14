import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CallCleanup } from './call.cleanup';
import { CallController } from './call.controller';
import { CallService } from './call.service';
import { LiveKitCallService } from './livekit.service';

@Module({
  imports: [OpenimModule, RealtimeModule],
  controllers: [CallController],
  providers: [CallService, LiveKitCallService, CallCleanup],
  exports: [CallService],
})
export class CallModule {}
