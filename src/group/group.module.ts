import { Module } from '@nestjs/common';
import { OpenimModule } from 'src/openim/openim.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { GroupController } from './group.controller';
import { GroupSyncOutboxProcessor } from './group-sync-outbox.processor';
import { GroupService } from './group.service';

@Module({
  imports: [OpenimModule, MembershipPolicyModule],
  controllers: [GroupController],
  providers: [
    GroupService,
    GroupSyncOutboxProcessor,
    CircleAdmissionPolicy,
    CircleMemberLockService,
  ],
  exports: [GroupService],
})
export class GroupModule {}
