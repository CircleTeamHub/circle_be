import { Module } from '@nestjs/common';
import { UploadModule } from 'src/upload/upload.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { ChatModule } from 'src/chat/chat.module';
import { AssistantModule } from 'src/assistant/assistant.module';
import { NoteShareLinkPublicController } from './note-share-link-public.controller';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';
import { NoteShareLinkCleanup } from './note-share-link.cleanup';
import { NoteRecycleBinCleanup } from './note-recycle-bin.cleanup';
import { NoteStatusFanoutOutboxProcessor } from './note-status-fanout-outbox.processor';
import { NOTE_CARD_PROJECTOR } from 'src/chat/note-card-projector';

@Module({
  imports: [
    UploadModule,
    MembershipPolicyModule,
    RealtimeModule,
    ChatModule,
    AssistantModule,
  ],
  controllers: [NoteController, NoteShareLinkPublicController],
  providers: [
    NoteService,
    NoteShareLinkCleanup,
    NoteRecycleBinCleanup,
    NoteStatusFanoutOutboxProcessor,
    // 聊天读路径按这个令牌取卡片内容投影(聊天模块不反向依赖笔记模块)。
    { provide: NOTE_CARD_PROJECTOR, useExisting: NoteService },
  ],
  exports: [NoteService, NOTE_CARD_PROJECTOR],
})
export class NoteModule {}
