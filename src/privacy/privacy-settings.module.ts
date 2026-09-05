import { Module } from '@nestjs/common';
import { SensitiveWordModule } from 'src/sensitive-word/sensitive-word.module';
import { PrivacySettingsController } from './privacy-settings.controller';
import { PrivacySettingsService } from './privacy-settings.service';

@Module({
  imports: [SensitiveWordModule],
  controllers: [PrivacySettingsController],
  providers: [PrivacySettingsService],
  exports: [PrivacySettingsService],
})
export class PrivacySettingsModule {}
