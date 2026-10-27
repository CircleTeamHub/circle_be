import { Module } from '@nestjs/common';
import { CoinController } from './coin.controller';
import { CoinService } from './coin.service';
import { GiftCardOutboxProcessor } from './gift-card-outbox.processor';
import { WalletReconciliationService } from './wallet-reconciliation.service';
import { ChatModule } from 'src/chat/chat.module';

@Module({
  imports: [ChatModule],
  controllers: [CoinController],
  providers: [
    CoinService,
    GiftCardOutboxProcessor,
    WalletReconciliationService,
  ],
  exports: [CoinService],
})
export class CoinModule {}
