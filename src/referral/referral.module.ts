import { Module } from '@nestjs/common';
import { CoinModule } from 'src/coin/coin.module';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { ReferralController } from './referral.controller';
import { ReferralService } from './referral.service';

@Module({
  imports: [CoinModule, NotificationModule, RealtimeModule],
  controllers: [ReferralController],
  providers: [ReferralService],
})
export class ReferralModule {}
