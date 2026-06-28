import { Module } from '@nestjs/common';
import { LikeController } from './like.controller';
import { LikeService } from './like.service';
import { LikeReconciliationService } from './like-reconciliation.service';

// PrismaService 与 IconService 均来自 @Global 模块，无需在此 imports。
@Module({
  controllers: [LikeController],
  providers: [LikeService, LikeReconciliationService],
  exports: [LikeService],
})
export class LikeModule {}
