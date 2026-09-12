import { Module } from '@nestjs/common';
import { RedisModule } from 'src/redis/redis.module';
import { SensitiveWordModule } from 'src/sensitive-word/sensitive-word.module';
import { PrivacySettingsController } from './privacy-settings.controller';
import { PrivacySettingsService } from './privacy-settings.service';

@Module({
  imports: [SensitiveWordModule, RedisModule],
  controllers: [PrivacySettingsController],
  providers: [PrivacySettingsService],
  exports: [PrivacySettingsService],
})
export class PrivacySettingsModule {}
