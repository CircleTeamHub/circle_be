import { Module } from '@nestjs/common';
import { CreditModule } from 'src/credit/credit.module';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { NoteRatingAdminController } from './note-rating-admin.controller';
import { NoteRatingAdminService } from './note-rating-admin.service';
import { NoteRatingController } from './note-rating.controller';
import { NoteRatingService } from './note-rating.service';

@Module({
  imports: [CreditModule, NotificationModule, RealtimeModule],
  controllers: [NoteRatingController, NoteRatingAdminController],
  providers: [NoteRatingService, NoteRatingAdminService],
})
export class NoteRatingModule {}
