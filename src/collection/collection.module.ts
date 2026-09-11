import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';

// 收藏的「这条消息还能不能被我看到」直接复用 ChatService.requireVisibleMessage,
// 所以要 import ChatModule(它 exports ChatService)。方向是 CollectionModule →
// ChatModule,chat 侧不认识收藏,不成环。
@Module({
  imports: [ChatModule],
  controllers: [CollectionController],
  providers: [CollectionService],
})
export class CollectionModule {}
