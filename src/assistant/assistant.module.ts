import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { AssistantController } from './assistant.controller';
import { AssistantAlertDeliveryProcessor } from './assistant-alert-delivery.processor';
import { AssistantService } from './assistant.service';
import { AssistantSubscriptionService } from './assistant-subscription.service';

@Module({
  imports: [ChatModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantSubscriptionService,
    AssistantAlertDeliveryProcessor,
  ],
  exports: [
    AssistantService,
    AssistantSubscriptionService,
    AssistantAlertDeliveryProcessor,
  ],
})
export class AssistantModule {}
