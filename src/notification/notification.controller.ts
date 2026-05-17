import { Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { NotificationService } from './notification.service';

@ApiTags('notification')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('notification')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get('unread-summary')
  @ApiOperation({ summary: 'Get unread notification summary for discover/profile domains' })
  getUnreadSummary(@Req() req: any) {
    return this.notificationService.getUnreadSummary(req.user.userId);
  }

  @Post('profile/read-all')
  @ApiOperation({ summary: 'Mark profile-domain notifications as read' })
  markProfileRead(@Req() req: any) {
    return this.notificationService.markProfileNotificationsRead(req.user.userId);
  }
}
