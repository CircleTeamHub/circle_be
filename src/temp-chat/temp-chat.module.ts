import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { OpenimModule } from 'src/openim/openim.module';
import { LinkTokenService } from './link-token.service';
import { TempChatCleanup } from './temp-chat.cleanup';
import { TempChatController } from './temp-chat.controller';
import { TempChatService } from './temp-chat.service';

@Module({
  imports: [
    OpenimModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('TEMP_CHAT_LINK_SECRET'),
      }),
    }),
  ],
  controllers: [TempChatController],
  providers: [TempChatService, LinkTokenService, TempChatCleanup],
  exports: [TempChatService],
})
export class TempChatModule {}
