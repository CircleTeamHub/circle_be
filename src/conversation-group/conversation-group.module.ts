import { Module } from '@nestjs/common';
import { ConversationGroupController } from './conversation-group.controller';
import { ConversationGroupService } from './conversation-group.service';

@Module({
  controllers: [ConversationGroupController],
  providers: [ConversationGroupService],
  exports: [ConversationGroupService],
})
export class ConversationGroupModule {}
