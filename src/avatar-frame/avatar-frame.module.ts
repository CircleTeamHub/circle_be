import { Module } from '@nestjs/common';
import { ModerationModule } from 'src/moderation/moderation.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { AvatarFrameAdminController } from './avatar-frame-admin.controller';
import { AvatarFrameAdminService } from './avatar-frame-admin.service';
import { AvatarFrameController } from './avatar-frame.controller';
import { AvatarFrameService } from './avatar-frame.service';

@Module({
  imports: [RealtimeModule, ModerationModule],
  controllers: [AvatarFrameController, AvatarFrameAdminController],
  providers: [AvatarFrameService, AvatarFrameAdminService],
  exports: [AvatarFrameService, AvatarFrameAdminService],
})
export class AvatarFrameModule {}
