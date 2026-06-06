import {
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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
  @ApiOperation({
    summary: 'Get unread notification summary for discover/profile domains',
  })
  getUnreadSummary(@Req() req: any) {
    return this.notificationService.getUnreadSummary(req.user.userId);
  }

  @Get('list')
  @ApiOperation({ summary: 'Paginated interactive notification list' })
  list(@Query('page') page: string | undefined, @Req() req: any) {
    return this.notificationService.getNotifications(
      req.user.userId,
      page ? parseInt(page, 10) : 1,
    );
  }

  @Put('read-all')
  @ApiOperation({ summary: 'Mark all interactive notifications as read' })
  readAll(@Req() req: any) {
    return this.notificationService.markAllNotificationsRead(req.user.userId);
  }

  @Put(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read' })
  read(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.notificationService.markNotificationRead(req.user.userId, id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete one notification' })
  remove(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.notificationService.deleteNotification(req.user.userId, id);
  }

  @Post('profile/read-all')
  @ApiOperation({ summary: 'Mark profile-domain notifications as read' })
  markProfileRead(@Req() req: any) {
    return this.notificationService.markProfileNotificationsRead(
      req.user.userId,
    );
  }
}
