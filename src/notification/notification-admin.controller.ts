import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Get,
  Delete,
  Patch,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
  AnnouncementScrollingDto,
  EditSystemAnnouncementDto,
  PublishSystemAnnouncementDto,
  PublishSystemAnnouncementResponseDto,
} from './notification.dto';
import { NotificationService } from './notification.service';

function auditContext(req: RequestWithUser) {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

function requireIdempotencyKey(value: string | undefined): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 128) {
    throw new BadRequestException(
      'Idempotency-Key header is required and must be at most 128 characters',
    );
  }
  return normalized;
}

@ApiTags('Admin System Announcements')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
@Controller('admin/system-announcements')
@RequireAdminPermission('CONTENT_MANAGE')
export class NotificationAdminController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  list() {
    return this.notificationService.adminAnnouncements();
  }

  @Patch(':id')
  edit(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EditSystemAnnouncementDto,
  ) {
    return this.notificationService.editAnnouncement(req.user.userId, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: RequestWithUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.notificationService.deleteAnnouncement(req.user.userId, id);
  }

  @Patch(':id/scrolling')
  setScrolling(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AnnouncementScrollingDto,
  ) {
    return this.notificationService.setAnnouncementScrolling(
      req.user.userId,
      id,
      dto.scrolling,
    );
  }

  @Post()
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @ApiOperation({ summary: 'Publish a system announcement to active users' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Stable key reused when retrying the same announcement',
  })
  publish(
    @Req() req: RequestWithUser,
    @Body() dto: PublishSystemAnnouncementDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PublishSystemAnnouncementResponseDto> {
    return this.notificationService.publishSystemAnnouncement(
      req.user.userId,
      dto,
      requireIdempotencyKey(idempotencyKey),
      auditContext(req),
    );
  }
}
