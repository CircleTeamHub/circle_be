import {
  Body,
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
import { DeletePushTokenDto, RegisterPushTokenDto } from './notification.dto';
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

  @Get('profile/list')
  @ApiOperation({
    summary: 'Paginated profile-domain system notification list',
  })
  profileList(@Query('page') page: string | undefined, @Req() req: any) {
    return this.notificationService.getProfileNotifications(
      req.user.userId,
      page ? parseInt(page, 10) : 1,
    );
  }

  @Put('read-all')
  @ApiOperation({ summary: 'Mark all interactive notifications as read' })
  readAll(@Req() req: any) {
    return this.notificationService.markAllNotificationsRead(req.user.userId);
  }

  @Put('push-token')
  @ApiOperation({
    summary: 'Register or refresh the current device push token',
  })
  registerPushToken(@Body() dto: RegisterPushTokenDto, @Req() req: any) {
    return this.notificationService.registerPushToken(req.user.userId, dto);
  }

  @Delete('push-token')
  @ApiOperation({ summary: 'Delete the current device push token' })
  deletePushToken(@Body() dto: DeletePushTokenDto, @Req() req: any) {
    return this.notificationService.deletePushToken(req.user.userId, dto.token);
  }

  @Get(':id/open-ownership')
  @ApiOperation({ summary: 'Check whether a push notification belongs to me' })
  openOwnership(@Param('id', ParseUUIDPipe) id: string, @Req() req: any) {
    return this.notificationService.getNotificationOpenOwnership(
      req.user.userId,
      id,
    );
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
