import { Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';
import { StorageAuditService } from './storage-audit.service';
import { UploadLimitService } from './upload-limit.service';
import { UploadIntentService } from './upload-intent.service';

@Module({
  imports: [RedisModule],
  providers: [
    UploadService,
    StorageAuditService,
    UploadLimitService,
    UploadIntentService,
  ],
  controllers: [UploadController],
  exports: [UploadService, UploadLimitService, UploadIntentService],
})
export class UploadModule {}
