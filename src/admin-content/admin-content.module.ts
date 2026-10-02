import { Module } from '@nestjs/common';
import { AdminContentController } from './admin-content.controller';
import { AdminContentService } from './admin-content.service';

@Module({
  controllers: [AdminContentController],
  providers: [AdminContentService],
})
export class AdminContentModule {}
