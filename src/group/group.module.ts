import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { PrivacySettingsModule } from 'src/privacy/privacy-settings.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { GroupController } from './group.controller';
import { GroupSyncOutboxProcessor } from './group-sync-outbox.processor';
import { GroupService } from './group.service';

@Module({
  imports: [OpenimModule, PrivacySettingsModule, MembershipPolicyModule],
  controllers: [GroupController],
  providers: [GroupService, GroupSyncOutboxProcessor, CircleAdmissionPolicy],
  exports: [GroupService],
})
export class GroupModule {}
