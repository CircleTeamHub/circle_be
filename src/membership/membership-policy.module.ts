import { Module } from '@nestjs/common';
import { MembershipPolicyService } from './membership-policy.service';
import { MembershipProgramService } from './membership-program.service';

@Module({
  providers: [MembershipPolicyService, MembershipProgramService],
  exports: [MembershipPolicyService, MembershipProgramService],
})
export class MembershipPolicyModule {}
