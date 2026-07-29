import { Module } from '@nestjs/common';
import { MembershipPolicyModule } from 'src/membership/membership-policy.module';
import { RealtimeModule } from 'src/realtime/realtime.module';
import { GroupExpansionController } from './group-expansion.controller';
import { GroupExpansionService } from './group-expansion.service';

@Module({
  imports: [MembershipPolicyModule, RealtimeModule],
  controllers: [GroupExpansionController],
  providers: [GroupExpansionService],
})
export class GroupExpansionModule {}
