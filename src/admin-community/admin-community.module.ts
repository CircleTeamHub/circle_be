import { Module } from '@nestjs/common';
import { AdminCommunityController } from './admin-community.controller';
import { AdminCommunityService } from './admin-community.service';
import { AdminGroupOperationProcessor } from './admin-group-operation.processor';

@Module({
  imports: [],
  controllers: [AdminCommunityController],
  providers: [AdminCommunityService, AdminGroupOperationProcessor],
})
export class AdminCommunityModule {}
