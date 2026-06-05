import { Module } from '@nestjs/common';
import { ChatHistoryController } from './chat-history.controller';
import { ChatHistoryService } from './chat-history.service';

@Module({
  controllers: [ChatHistoryController],
  providers: [ChatHistoryService],
})
export class ChatHistoryModule {}
