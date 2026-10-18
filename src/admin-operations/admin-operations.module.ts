import { Module } from '@nestjs/common';
import { AdminOperationsController } from './admin-operations.controller';
import { AdminAuditQueryService } from './admin-audit-query.service';
import { AdminInviteService } from './admin-invite.service';
@Module({
  controllers: [AdminOperationsController],
  providers: [AdminAuditQueryService, AdminInviteService],
})
export class AdminOperationsModule {}
