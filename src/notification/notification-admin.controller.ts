import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
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

@ApiTags('Admin System Announcements')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/system-announcements')
export class NotificationAdminController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post()
  @ApiOperation({ summary: 'Publish a system announcement to active users' })
  publish(
    @Req() req: RequestWithUser,
    @Body() dto: PublishSystemAnnouncementDto,
  ): Promise<PublishSystemAnnouncementResponseDto> {
    return this.notificationService.publishSystemAnnouncement(
      req.user.userId,
      dto,
      auditContext(req),
    );
  }
}
