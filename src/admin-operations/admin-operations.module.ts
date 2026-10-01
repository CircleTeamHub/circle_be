import { Module } from '@nestjs/common';
import {
  AdminOperationsController,
  PublishedAdvertisementsController,
} from './admin-operations.controller';
import { AdminAuditQueryService } from './admin-audit-query.service';
import { AdminInviteService } from './admin-invite.service';
import { AdminAdvertisementService } from './admin-advertisement.service';
@Module({
  controllers: [AdminOperationsController, PublishedAdvertisementsController],
  providers: [
    AdminAuditQueryService,
    AdminInviteService,
    AdminAdvertisementService,
  ],
})
export class AdminOperationsModule {}
