import { Module } from '@nestjs/common';
import { UploadModule } from 'src/upload/upload.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NoteShareLinkPublicController } from './note-share-link-public.controller';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';
import { NoteShareLinkCleanup } from './note-share-link.cleanup';
import { NoteRecycleBinCleanup } from './note-recycle-bin.cleanup';
import { NoteContentJsonRepair } from './note-content-json-repair';

@Module({
  imports: [UploadModule, MembershipPolicyModule, RealtimeModule],
  controllers: [NoteController, NoteShareLinkPublicController],
  providers: [
    NoteService,
    NoteShareLinkCleanup,
    NoteRecycleBinCleanup,
    NoteContentJsonRepair,
  ],
  exports: [NoteService],
})
export class NoteModule {}
