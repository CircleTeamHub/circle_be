import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ConfigEnum } from 'src/enum/config.enum';
import { SensitiveWordModule } from 'src/sensitive-word/sensitive-word.module';
import { ChatBroadcastService } from './chat-broadcast.service';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

// PrismaService 与 SessionRevocationService 来自 @Global 模块(Prisma/Auth);
// JwtModule 仿 RealtimeModule 各自注册(verify 用);敏感词服务显式 import。
@Module({
  imports: [
    SensitiveWordModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        secret: configService.get<string>(ConfigEnum.SECRET),
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [ChatController],
  providers: [ChatGateway, ChatService, ChatBroadcastService],
  exports: [ChatService, ChatBroadcastService],
})
export class ChatModule {}
