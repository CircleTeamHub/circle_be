import {
  BadRequestException,
  Body,
  Controller,
  Headers,
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
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/system-announcements')
export class NotificationAdminController {
  constructor(private readonly notificationService: NotificationService) {}

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
