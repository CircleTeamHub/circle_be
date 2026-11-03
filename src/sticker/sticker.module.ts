import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { UploadModule } from 'src/upload/upload.module';
import { StickerController } from './sticker.controller';
import { StickerService } from './sticker.service';

@Module({
  imports: [ChatModule, UploadModule],
  controllers: [StickerController],
  providers: [StickerService],
})
export class StickerModule {}
