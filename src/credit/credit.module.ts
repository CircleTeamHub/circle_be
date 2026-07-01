import { Module } from '@nestjs/common';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CreditController } from './credit.controller';
import { CreditPolicyService } from './credit-policy.service';
import { CreditService } from './credit.service';
import { OpenimCreditCallbackController } from './openim-credit-callback.controller';

@Module({
  imports: [RealtimeModule],
  controllers: [CreditController, OpenimCreditCallbackController],
  providers: [CreditPolicyService, CreditService],
  exports: [CreditPolicyService, CreditService],
})
export class CreditModule {}
