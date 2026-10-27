import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AnonymousAccess } from 'src/guards/anonymous-access.decorator';
import { verifyDeclineToken } from './call-decline-token';
import { CallPushService } from './call-push.service';
import { CallService } from './call.service';
import { PushDeclineDto } from './dto/call.dto';

/**
 * 推送来电的免登录入口。锁屏上点「拒接」时 App 的 JS 多半没在跑、登录态也过期了，
 * 原生层只拿得到推送里的单通拒接令牌（见 call-decline-token.ts）。
 *
 * 成功与「这通早就不在振铃了」都回 204，令牌不对回 401：不从状态码里透露通话后来
 * 怎样了，免得它被当成探测接口。
 */
@ApiTags('Calls')
@UseGuards(ThrottlerGuard)
@Controller('calls')
export class CallPushController {
  constructor(
    private readonly callService: CallService,
    private readonly callPush: CallPushService,
  ) {}

  @AnonymousAccess('Single-call decline token carried by an incoming-call push')
  @Post(':callId/push-decline')
  @HttpCode(204)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async pushDecline(
    @Param('callId', ParseUUIDPipe) callId: string,
    @Body() dto: PushDeclineDto,
  ): Promise<void> {
    const userID = verifyDeclineToken(
      this.callPush.getDeclineKey(),
      callId,
      dto.token,
    );
    if (!userID) {
      throw new UnauthorizedException('CALL_PUSH_TOKEN_INVALID');
    }
    await this.callService.declineFromPush(userID, callId);
  }
}
