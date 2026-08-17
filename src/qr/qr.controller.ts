import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { IssueQrTokenDto } from './dto/qr.dto';
import { QrService } from './qr.service';
import type { QrJoinResultDto, QrResolveDto, QrTokenDto } from './qr.types';

/**
 * 二维码令牌:个人名片 / 独立群聊 / 圈子。签发、扫码预览、扫码加入。
 * 全部要求登录 —— 扫码动作发生在 App 内(或外部相机唤起 App 后),没有匿名面。
 */
@ApiTags('qr')
@ApiBearerAuth()
@Controller('qr')
@UseGuards(JwtGuard, AppAudienceGuard, ThrottlerGuard)
export class QrController {
  constructor(private readonly qrService: QrService) {}

  @Post('tokens')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '签发二维码令牌(有效窗口内复用)' })
  issue(
    @Req() req: RequestWithUser,
    @Body() dto: IssueQrTokenDto,
  ): Promise<QrTokenDto> {
    return this.qrService.issueToken(req.user.userId, dto.type, dto.targetId);
  }

  @Get('tokens/:token')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '扫码落地页预览' })
  resolve(
    @Req() req: RequestWithUser,
    @Param('token') token: string,
  ): Promise<QrResolveDto> {
    return this.qrService.resolveToken(req.user.userId, token);
  }

  @Post('tokens/:token/join')
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @ApiOperation({ summary: '扫码加入(群入座 / 圈子走邀请语义)' })
  join(
    @Req() req: RequestWithUser,
    @Param('token') token: string,
  ): Promise<QrJoinResultDto> {
    return this.qrService.joinByToken(req.user.userId, token);
  }
}
