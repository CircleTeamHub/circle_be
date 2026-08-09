import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { AdminCommunityController } from './admin-community.controller';
import { AdminCommunityService } from './admin-community.service';
import { AdminGroupOperationProcessor } from './admin-group-operation.processor';

@Module({
  // 停用/恢复圈子要连带收回或重建群聊座位(ChatCircleSyncService)。
  imports: [ChatModule],
  controllers: [AdminCommunityController],
  providers: [AdminCommunityService, AdminGroupOperationProcessor],
})
export class AdminCommunityModule {}
