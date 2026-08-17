import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { CircleInvitationModule } from 'src/circle-invitation/circle-invitation.module';
import { QrController } from './qr.controller';
import { QrService } from './qr.service';

// PrismaService 来自 @Global 模块;群入座复用 ChatService,圈子入圈复用
// CircleInvitationService(邀请语义,签发人=邀请人)。
@Module({
  imports: [ChatModule, CircleInvitationModule],
  controllers: [QrController],
  providers: [QrService],
  exports: [QrService],
})
export class QrModule {}
