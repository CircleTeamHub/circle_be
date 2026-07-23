import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CallService } from './call.service';
import {
  CreateDirectCallDto,
  CreateGroupCallDto,
  LeaveCallDto,
} from './dto/call.dto';

@ApiTags('Calls')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtGuard)
@Controller('calls')
export class CallController {
  constructor(private readonly callService: CallService) {}

  @Post('group')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createGroupCall(
    @Body() dto: CreateGroupCallDto,
    @Req() req: RequestWithUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.callService.createGroupCall(
      req.user.userId,
      dto,
      idempotencyKey,
    );
  }

  @Post('direct')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createDirectCall(
    @Body() dto: CreateDirectCallDto,
    @Req() req: RequestWithUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.callService.createDirectCall(
      req.user.userId,
      dto,
      idempotencyKey,
    );
  }

  // 固定路径必须先于 :callId 参数路由声明，否则 'current' 会被吃进参数。
  @Get('current')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  getCurrentCall(@Req() req: RequestWithUser) {
    return this.callService.getCurrentCall(req.user.userId);
  }

  @Post(':callId/accept')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  acceptCall(@Param('callId') callId: string, @Req() req: RequestWithUser) {
    return this.callService.acceptCall(req.user.userId, callId);
  }

  @Post(':callId/reject')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  rejectCall(@Param('callId') callId: string, @Req() req: RequestWithUser) {
    return this.callService.rejectCall(req.user.userId, callId);
  }

  @Post(':callId/leave')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  leaveCall(
    @Param('callId') callId: string,
    @Body() _dto: LeaveCallDto,
    @Req() req: RequestWithUser,
  ) {
    return this.callService.leaveCall(req.user.userId, callId);
  }

  @Post(':callId/cancel')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  cancelCall(@Param('callId') callId: string, @Req() req: RequestWithUser) {
    return this.callService.cancelCall(req.user.userId, callId);
  }

  @Post(':callId/join-token')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  createJoinToken(
    @Param('callId') callId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.callService.createJoinToken(req.user.userId, callId);
  }
}
