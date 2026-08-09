import { Module } from '@nestjs/common';
import { ChatModule } from 'src/chat/chat.module';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { CircleAdmissionPolicy } from 'src/circle/circle-admission-policy';
import { CircleMemberLockService } from 'src/circle/circle-member-lock';
import { GroupController } from './group.controller';
import { GroupService } from './group.service';

@Module({
  imports: [ChatModule, MembershipPolicyModule],
  controllers: [GroupController],
  providers: [GroupService, CircleAdmissionPolicy, CircleMemberLockService],
  exports: [GroupService],
})
export class GroupModule {}
