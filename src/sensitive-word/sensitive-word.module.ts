import { Module } from '@nestjs/common';
import { ModerationModule } from 'src/moderation/moderation.module';
import { SensitiveWordAdminController } from './sensitive-word-admin.controller';
import { SensitiveWordService } from './sensitive-word.service';

@Module({
  imports: [ModerationModule],
  controllers: [SensitiveWordAdminController],
  providers: [SensitiveWordService],
  exports: [SensitiveWordService],
})
export class SensitiveWordModule {}
