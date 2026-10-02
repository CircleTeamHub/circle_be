import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { UploadModule } from 'src/upload/upload.module';
import { GroupModule } from 'src/group/group.module';
import { AdminImController } from './admin-im.controller';
import { AdminImService } from './admin-im.service';
@Module({
  imports: [ChatModule, GroupModule, UploadModule],
  controllers: [AdminImController],
  providers: [AdminImService],
})
export class AdminImModule {}
