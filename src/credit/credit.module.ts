import { Module } from '@nestjs/common';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';

@Module({
  imports: [RealtimeModule],
  controllers: [CreditController],
  providers: [CreditService],
  exports: [CreditService],
})
export class CreditModule {}
