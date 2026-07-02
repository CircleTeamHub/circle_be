import { Module } from '@nestjs/common';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CreditService } from './credit.service';

@Module({
  imports: [RealtimeModule],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
