import { Module } from '@nestjs/common';
import { NotificationModule } from 'src/notification/notification.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { CirclePlazaController } from './circle-plaza.controller';
import { CirclePlazaCleanup } from './circle-plaza.cleanup';
import { CirclePlazaService } from './circle-plaza.service';
import { AvatarFrameModule } from 'src/avatar-frame/avatar-frame.module';
import { AssistantModule } from 'src/assistant/assistant.module';
import { NoteModule } from 'src/note/note.module';
import { UploadModule } from 'src/upload/upload.module';

@Module({
  imports: [
    RealtimeModule,
    NotificationModule,
    MembershipPolicyModule,
    AvatarFrameModule,
    AssistantModule,
    // 动态附带笔记的卡片投影（NoteService.projectPlazaNoteCards）。
    NoteModule,
    UploadModule,
  ],
  controllers: [CirclePlazaController],
  providers: [CirclePlazaService, CirclePlazaCleanup],
})
export class CirclePlazaModule {}
