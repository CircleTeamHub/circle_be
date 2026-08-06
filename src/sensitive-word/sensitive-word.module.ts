import { Module } from '@nestjs/common';
import { ModerationModule } from 'src/moderation/moderation.module';
import { OpenimCallbackController } from './openim-callback.controller';
import { SensitiveWordAdminController } from './sensitive-word-admin.controller';
import { SensitiveWordService } from './sensitive-word.service';

@Module({
  imports: [ModerationModule],
  controllers: [OpenimCallbackController, SensitiveWordAdminController],
  providers: [SensitiveWordService],
  exports: [SensitiveWordService],
})
export class SensitiveWordModule {}
