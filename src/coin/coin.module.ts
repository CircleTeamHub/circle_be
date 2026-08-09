import { Module } from '@nestjs/common';
import { CoinController } from './coin.controller';
import { CoinService } from './coin.service';
import { GiftCardOutboxProcessor } from './gift-card-outbox.processor';
import { ChatModule } from 'src/chat/chat.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NotificationModule } from 'src/notification/notification.module';

@Module({
  imports: [RealtimeModule, NotificationModule, ChatModule],
  controllers: [CoinController],
  providers: [CoinService, GiftCardOutboxProcessor],
  exports: [CoinService],
})
export class CoinModule {}
