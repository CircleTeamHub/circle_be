import { Module } from '@nestjs/common';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { CreditController } from './credit.controller';
import { CreditPolicyService } from './credit-policy.service';
import { CreditService } from './credit.service';
import { OpenimCreditCallbackController } from './openim-credit-callback.controller';
import { OpenimCallbackGuard } from './openim-callback.guard';

@Module({
  imports: [RealtimeModule],
  controllers: [CreditController, OpenimCreditCallbackController],
  providers: [CreditPolicyService, CreditService, OpenimCallbackGuard],
  exports: [CreditPolicyService, CreditService],
})
export class CreditModule {}
