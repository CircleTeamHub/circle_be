import { Module } from '@nestjs/common';
import { NotificationModule } from 'src/notification/notification.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { LikeController } from './like.controller';
import { LikeService } from './like.service';
import { LikeReconciliationService } from './like-reconciliation.service';

// PrismaService 与 IconService 来自 @Global 模块；NotificationService 亦 @Global，
// 但 RealtimeService 不是——故显式 import RealtimeModule（连同 NotificationModule）。
@Module({
  imports: [NotificationModule, RealtimeModule],
  controllers: [LikeController],
  providers: [LikeService, LikeReconciliationService],
  exports: [LikeService],
})
export class LikeModule {}
