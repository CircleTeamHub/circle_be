import { Module } from '@nestjs/common';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { FancyNumberAdminController } from './fancy-number-admin.controller';
import { FancyNumberController } from './fancy-number.controller';
import { FancyNumberCleanup } from './fancy-number.cleanup';
import { FancyNumberService } from './fancy-number.service';

@Module({
  imports: [RealtimeModule],
  controllers: [FancyNumberController, FancyNumberAdminController],
  providers: [FancyNumberService, FancyNumberCleanup],
  exports: [FancyNumberService],
})
export class FancyNumberModule {}
