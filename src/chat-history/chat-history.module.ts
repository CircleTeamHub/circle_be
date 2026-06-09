import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { ChatHistoryController } from './chat-history.controller';
import { ChatHistoryService } from './chat-history.service';

@Module({
  imports: [OpenimModule],
  controllers: [ChatHistoryController],
  providers: [ChatHistoryService],
})
export class ChatHistoryModule {}
