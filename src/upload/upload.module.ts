import { Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';
import { UploadService } from './upload.service';
import { UploadController } from './upload.controller';

@Module({
  imports: [RedisModule],
  providers: [UploadService],
  controllers: [UploadController],
  exports: [UploadService],
})
export class UploadModule {}
