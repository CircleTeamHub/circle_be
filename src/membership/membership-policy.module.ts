import { Module } from '@nestjs/common';
import { MembershipPolicyService } from './membership-policy.service';

@Module({
  providers: [MembershipPolicyService],
  exports: [MembershipPolicyService],
})
export class MembershipPolicyModule {}
