import { Module } from '@nestjs/common';
import { UploadModule } from 'src/upload/upload.module';
import { NoteShareLinkPublicController } from './note-share-link-public.controller';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

@Module({
  imports: [UploadModule],
  controllers: [NoteController, NoteShareLinkPublicController],
  providers: [NoteService],
})
export class NoteModule {}
