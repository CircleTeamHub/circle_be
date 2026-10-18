import {
  Body,
  Controller,
  Get,
  Headers,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import { AnonymousAccess } from 'src/guards/anonymous-access.decorator';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  AppOpenDto,
  AdminUpdatePreviewQuery,
  ConsoleQuery,
  CreateKeyDto,
  DiagnosticQuery,
  PushSendDto,
  PushSettingsDto,
  ReasonDto,
  ReleaseDto,
  ReleasePlanDto,
  RetryDto,
  UpdateDecisionQuery,
} from './console.dto';
import { ConsoleOperationsService } from './console-operations.service';
import { ConsoleInsightsService } from './console-insights.service';
import {
  ConsoleKeysService,
  ConsoleKeyGuard,
  ConsoleScope,
} from './console-keys.service';
import { ConsoleReleasesService } from './console-releases.service';

@ApiTags('Admin Operations Console')
@ApiBearerAuth()
@Controller('admin/console')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard, UserThrottlerGuard)
@Throttle({ default: { limit: 120, ttl: 60000 } })
export class ConsoleController {
  constructor(
    private readonly ops: ConsoleOperationsService,
    private readonly insights: ConsoleInsightsService,
    private readonly keys: ConsoleKeysService,
    private readonly releases: ConsoleReleasesService,
  ) {}
  @Get('tasks/overview') @RequireAdminPermission('DASHBOARD') overview() {
    return this.ops.taskOverview();
  }
  @Get('tasks') @RequireAdminPermission('DASHBOARD') tasks(
    @Query() q: ConsoleQuery,
  ) {
    return this.ops.tasks(q);
  }
  @Get('push/overview')
  @RequireAdminPermission('SUPPORT_MANAGE')
  pushOverview() {
    return this.ops.pushOverview();
  }
  @Get('push') @RequireAdminPermission('SUPPORT_MANAGE') pushes(
    @Query() q: ConsoleQuery,
  ) {
    return this.ops.pushes(q);
  }
  @Get('push/devices/:id') @RequireAdminPermission('SUPPORT_MANAGE') devices(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.ops.devices(id);
  }
  @Get('push/announcements')
  @RequireAdminPermission('CONTENT_MANAGE')
  announcements() {
    return this.ops.announcements();
  }
  @Post('push/:id/retry') @RequireAdminPermission('SUPPORT_MANAGE') retry(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RetryDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.ops.retryPush(req.user.userId, id, dto, key);
  }
  @Patch('push/settings') @RequireAdminPermission('CONTENT_MANAGE') settings(
    @Req() req: RequestWithUser,
    @Body() dto: PushSettingsDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.ops.settings(req.user.userId, dto, key);
  }
  @Post('push/send')
  @RequireAdminPermission('CONTENT_MANAGE')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  send(
    @Req() req: RequestWithUser,
    @Body() dto: PushSendDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.ops.send(req.user.userId, dto, key);
  }
  @Get('users/:id/timeline') @RequireAdminPermission('USER_READ') timeline(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: ConsoleQuery,
  ) {
    return this.insights.timeline(id, q);
  }
  @Get('analytics') @RequireAdminPermission('DASHBOARD') analytics(
    @Query() q: ConsoleQuery,
  ) {
    return this.insights.analytics(q.days);
  }
  @Get('events') @RequireAdminPermission('AUDIT_READ') events(
    @Query() q: ConsoleQuery,
  ) {
    return this.insights.events(q);
  }
  @Get('diagnostics') @RequireAdminPermission('AUDIT_READ') diagnostics(
    @Query() q: DiagnosticQuery,
  ) {
    return this.insights.diagnostics(q);
  }
  @Get('keys') @RequireAdminPermission('ACCESS_MANAGE') keyList(
    @Req() req: RequestWithUser,
  ) {
    return this.keys.list(req.user.userId);
  }
  @Post('keys')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('ACCESS_MANAGE')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  keyCreate(@Req() req: RequestWithUser, @Body() dto: CreateKeyDto) {
    return this.keys.create(req.user.userId, dto);
  }
  @Post('keys/:id/revoke') @RequireAdminPermission('ACCESS_MANAGE') keyRevoke(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.keys.revoke(req.user.userId, id, dto, key);
  }
  @Get('releases') @RequireAdminPermission('CONTENT_MANAGE') releaseList() {
    return this.releases.list();
  }
  @Post('releases') @RequireAdminPermission('CONTENT_MANAGE') releaseCreate(
    @Req() req: RequestWithUser,
    @Body() dto: ReleaseDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.releases.create(req.user.userId, dto, key);
  }
  @Post('releases/:id/withdraw')
  @RequireAdminPermission('CONTENT_MANAGE')
  releaseWithdraw(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.releases.withdraw(req.user.userId, id, dto, key);
  }
  @Post('release-plans') @RequireAdminPermission('CONTENT_MANAGE') planCreate(
    @Req() req: RequestWithUser,
    @Body() dto: ReleasePlanDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.releases.plan(req.user.userId, undefined, dto, key);
  }
  @Patch('release-plans/:id')
  @RequireAdminPermission('CONTENT_MANAGE')
  planUpdate(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReleasePlanDto,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.releases.plan(req.user.userId, id, dto, key);
  }
  @Get('releases/preview')
  @Header('Cache-Control', 'no-store')
  @RequireAdminPermission('CONTENT_MANAGE')
  preview(@Query() q: AdminUpdatePreviewQuery) {
    return this.releases.preview(q);
  }
}

@ApiTags('App Operations')
@Controller('app-operations')
export class AppOperationsController {
  constructor(
    private readonly insights: ConsoleInsightsService,
    private readonly releases: ConsoleReleasesService,
  ) {}
  @Post('open')
  @UseGuards(JwtGuard, UserThrottlerGuard)
  @Throttle({ default: { limit: 12, ttl: 60000 } })
  open(
    @Req() req: RequestWithUser,
    @Headers('x-device-id') device: string | undefined,
    @Body() dto: AppOpenDto,
  ) {
    return this.insights.appOpen(
      req.user.userId,
      device,
      dto,
      req.user.sessionId,
    );
  }
  @Get('update')
  @Header('Cache-Control', 'no-store')
  @AnonymousAccess(
    'Public release decision contains only published release metadata; no account data',
  )
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  update(@Query() q: UpdateDecisionQuery) {
    return this.releases.decision(q);
  }
}

@ApiTags('Read-only Automation')
@ApiBearerAuth()
@Controller('ops/read')
@UseGuards(
  UserThrottlerGuard,
  ConsoleKeyGuard,
  AdminGuard,
  AdminPermissionGuard,
)
@Throttle({ default: { limit: 60, ttl: 60000 } })
export class ConsoleToolController {
  constructor(
    private readonly ops: ConsoleOperationsService,
    private readonly insights: ConsoleInsightsService,
  ) {}
  @Get('tasks')
  @AnonymousAccess(
    'Authenticated by ConsoleKeyGuard with current administrator and scope checks',
  )
  @RequireAdminPermission('DASHBOARD')
  @ConsoleScope('tasks')
  tasks() {
    return this.ops.taskOverview();
  }
  @Get('push')
  @AnonymousAccess(
    'Authenticated by ConsoleKeyGuard with current administrator and scope checks',
  )
  @RequireAdminPermission('SUPPORT_MANAGE')
  @ConsoleScope('push')
  pushes(@Query() q: ConsoleQuery) {
    return this.ops.pushes(q);
  }
  @Get('users/:id/timeline')
  @AnonymousAccess(
    'Authenticated by ConsoleKeyGuard with current administrator and scope checks',
  )
  @RequireAdminPermission('USER_READ')
  @ConsoleScope('timeline')
  timeline(@Param('id', ParseUUIDPipe) id: string, @Query() q: ConsoleQuery) {
    return this.insights.timeline(id, q);
  }
  @Get('analytics')
  @AnonymousAccess(
    'Authenticated by ConsoleKeyGuard with current administrator and scope checks',
  )
  @RequireAdminPermission('DASHBOARD')
  @ConsoleScope('analytics')
  analytics(@Query() q: ConsoleQuery) {
    return this.insights.analytics(q.days);
  }
  @Get('diagnostics')
  @AnonymousAccess(
    'Authenticated by ConsoleKeyGuard with current administrator and scope checks',
  )
  @RequireAdminPermission('AUDIT_READ')
  @ConsoleScope('diagnostics')
  diagnostics(@Query() q: DiagnosticQuery) {
    return this.insights.diagnostics(q);
  }
}
