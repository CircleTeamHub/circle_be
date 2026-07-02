import { Module } from '@nestjs/common';
import { UploadModule } from 'src/upload/upload.module';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';

@Module({
  imports: [UploadModule],
  controllers: [NoteController],
  providers: [NoteService],
})
export class NoteModule {}
