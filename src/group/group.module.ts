import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { GroupController } from './group.controller';
import { GroupSyncOutboxProcessor } from './group-sync-outbox.processor';
import { GroupService } from './group.service';

@Module({
  imports: [OpenimModule, PrivacySettingsModule],
  controllers: [GroupController],
  providers: [GroupService, GroupSyncOutboxProcessor],
  exports: [GroupService],
})
export class GroupModule {}
