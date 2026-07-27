import { Module } from '@nestjs/common';
import { UploadModule } from 'src/upload/upload.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { NoteShareLinkPublicController } from './note-share-link-public.controller';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';
import { NoteShareLinkCleanup } from './note-share-link.cleanup';

@Module({
  imports: [UploadModule, MembershipPolicyModule],
  controllers: [NoteController, NoteShareLinkPublicController],
  providers: [NoteService, NoteShareLinkCleanup],
})
export class NoteModule {}
