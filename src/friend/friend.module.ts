import { Module } from '@nestjs/common';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { FriendController } from './friend.controller';
import { FriendService } from './friend.service';

@Module({
  imports: [RealtimeModule],
  controllers: [FriendController],
  providers: [FriendService],
  exports: [FriendService],
})
export class FriendModule {}
