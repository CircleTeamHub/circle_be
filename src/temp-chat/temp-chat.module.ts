import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ChatModule } from 'src/chat/chat.module';
import { NoteModule } from 'src/note/note.module';
import { UploadModule } from 'src/upload/upload.module';
import { LinkTokenService } from './link-token.service';
import { TempChatCleanup } from './temp-chat.cleanup';
import { TempChatController } from './temp-chat.controller';
import { TempChatGuestGuard } from './temp-chat-guest.guard';
import { TempChatService } from './temp-chat.service';
import { TempChatUploadQuota } from './temp-chat-upload-quota';

@Module({
  imports: [
    ChatModule,
    NoteModule,
    UploadModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('TEMP_CHAT_LINK_SECRET'),
      }),
    }),
  ],
  controllers: [TempChatController],
  providers: [
    TempChatService,
    LinkTokenService,
    TempChatCleanup,
    TempChatGuestGuard,
    TempChatUploadQuota,
  ],
  exports: [TempChatService],
})
export class TempChatModule {}
