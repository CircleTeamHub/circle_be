import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import { AdminPageQuery } from 'src/admin-access/admin-access.dto';
import type { RequestWithUser } from 'src/auth/types';
import { AdminAuditQueryService } from './admin-audit-query.service';
import { AdminInviteService } from './admin-invite.service';
import { AdminAdvertisementService } from './admin-advertisement.service';
import {
  AdvertisementDto,
  AuditQuery,
  CreateCampaignDto,
  PublishedAdvertisementQuery,
  ReferralQuery,
  UpdateAdvertisementDto,
  UpdateCampaignDto,
} from './admin-operations.dto';

@Controller('admin/operations')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
export class AdminOperationsController {
  constructor(
    private readonly audit: AdminAuditQueryService,
    private readonly invites: AdminInviteService,
    private readonly ads: AdminAdvertisementService,
  ) {}
  @Get('audit-logs')
  @RequireAdminPermission('AUDIT_READ')
  auditLogs(@Query() query: AuditQuery) {
    return this.audit.list(query);
  }
  @Get('invite-codes')
  @RequireAdminPermission('CONTENT_MANAGE')
  personalCodes(@Query() query: AdminPageQuery) {
    return this.invites.personalCodes(query);
  }
  @Get('campaign-invites')
  @RequireAdminPermission('CONTENT_MANAGE')
  campaigns(@Query() query: AdminPageQuery) {
    return this.invites.campaigns(query);
  }
  @Post('campaign-invites')
  @RequireAdminPermission('CONTENT_MANAGE')
  createCampaign(
    @Req() req: RequestWithUser,
    @Body() dto: CreateCampaignDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.invites.create(req.user.userId, dto, key);
  }
  @Patch('campaign-invites/:id')
  @RequireAdminPermission('CONTENT_MANAGE')
  updateCampaign(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCampaignDto,
  ) {
    return this.invites.update(req.user.userId, id, dto);
  }
  @Get('referrals')
  @RequireAdminPermission('CONTENT_MANAGE')
  referrals(@Query() query: ReferralQuery) {
    return this.invites.referrals(query);
  }
  @Get('advertisements')
  @RequireAdminPermission('CONTENT_MANAGE')
  advertisements(@Query() query: AdminPageQuery) {
    return this.ads.list(query);
  }
  @Post('advertisements')
  @RequireAdminPermission('CONTENT_MANAGE')
  createAdvertisement(
    @Req() req: RequestWithUser,
    @Body() dto: AdvertisementDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.ads.create(req.user.userId, dto, key);
  }
  @Patch('advertisements/:id')
  @RequireAdminPermission('CONTENT_MANAGE')
  updateAdvertisement(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdvertisementDto,
  ) {
    return this.ads.update(req.user.userId, id, dto);
  }
}

@Controller('advertisements')
@UseGuards(JwtGuard)
export class PublishedAdvertisementsController {
  constructor(private readonly ads: AdminAdvertisementService) {}
  @Get()
  list(@Query() query: PublishedAdvertisementQuery) {
    return this.ads.published(query.placement);
  }
}
