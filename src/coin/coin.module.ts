import { Module } from '@nestjs/common';
import { CoinController } from './coin.controller';
import { CoinService } from './coin.service';
import { GiftCardOutboxProcessor } from './gift-card-outbox.processor';
import { OpenimModule } from 'src/openim/openim.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NotificationModule } from 'src/notification/notification.module';

@Module({
  imports: [RealtimeModule, NotificationModule, OpenimModule],
  controllers: [CoinController],
  providers: [CoinService, GiftCardOutboxProcessor],
  exports: [CoinService],
})
export class CoinModule {}
