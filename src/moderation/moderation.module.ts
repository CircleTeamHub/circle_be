import { Module } from '@nestjs/common';
import { AdminAuditService } from './admin-audit.service';
import { ModerationAdminController } from './moderation-admin.controller';
import { ModerationAdminService } from './moderation-admin.service';

@Module({
  controllers: [ModerationAdminController],
  providers: [ModerationAdminService, AdminAuditService],
  exports: [AdminAuditService],
})
export class ModerationModule {}
