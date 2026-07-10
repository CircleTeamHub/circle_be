import { Body, Controller, Delete, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { RevokePushTokenDto } from './notification.dto';
import { NotificationService } from './notification.service';

@ApiTags('notification')
@UseGuards(ThrottlerGuard)
@Controller('notification')
export class NotificationPublicController {
  constructor(private readonly notificationService: NotificationService) {}

  @Delete('push-token/revoke')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Revoke a device push token with its secret' })
  revokePushToken(@Body() dto: RevokePushTokenDto) {
    return this.notificationService.revokePushToken(dto);
  }
}
