import { Global, Module } from '@nestjs/common';
import { IconController } from './icon.controller';
import { IconService } from './icon.service';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';

@Global()
@Module({
  imports: [RealtimeModule, PrivacySettingsModule],
  controllers: [IconController],
  providers: [IconService],
  exports: [IconService],
})
export class IconModule {}
