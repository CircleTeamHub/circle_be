import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { ChatHistoryController } from './chat-history.controller';
import { ChatHistoryService } from './chat-history.service';

@Module({
  imports: [OpenimModule, PrivacySettingsModule],
  controllers: [ChatHistoryController],
  providers: [ChatHistoryService],
})
export class ChatHistoryModule {}
