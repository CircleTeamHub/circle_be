import { Module } from '@nestjs/common';
import { AdminUserModule } from 'src/admin-user/admin-user.module';
import { AvatarFrameModule } from 'src/avatar-frame/avatar-frame.module';
import { ChatModule } from 'src/chat/chat.module';
import { CoinModule } from 'src/coin/coin.module';
import { MembershipModule } from 'src/membership/membership.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { UploadModule } from 'src/upload/upload.module';
import { SupportRechargeAdminController } from './support-recharge-admin.controller';
import { SupportRechargeService } from './support-recharge.service';

@Module({
  imports: [
    AdminUserModule,
    AvatarFrameModule,
    ChatModule,
    CoinModule,
    MembershipModule,
    RealtimeModule,
    UploadModule,
  ],
  controllers: [SupportRechargeAdminController],
  providers: [SupportRechargeService],
})
export class SupportRechargeModule {}
