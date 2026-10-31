import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  CreateAssistantSubscriptionDto,
  UpdateAssistantPreferencesDto,
  UpdateAssistantSubscriptionDto,
} from './assistant.dto';
import { AssistantService } from './assistant.service';
import { AssistantSubscriptionService } from './assistant-subscription.service';

@ApiTags('assistant')
// AppAudienceGuard:小助手会话和订阅是普通用户能力,管理台的 ADMIN token 同样能过
// JwtGuard,不该能建助手会话或改用户的订阅与偏好。
@UseGuards(JwtGuard, AppAudienceGuard)
@Controller('assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly subscriptions: AssistantSubscriptionService,
  ) {}

  @Get('bootstrap')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '获取或创建当前用户的风信助手会话' })
  bootstrap(
    @Req() req: RequestWithUser,
    @Query('contextCircleId') contextCircleId?: string,
  ) {
    return Promise.all([
      this.assistant.bootstrap(req.user.userId),
      this.subscriptions.list(req.user.userId),
      this.subscriptions.getContextCircle(req.user.userId, contextCircleId),
      this.assistant.getPreferences(req.user.userId),
    ]).then(([base, subscriptions, contextCircle, preferences]) => ({
      ...base,
      subscriptions,
      contextCircle,
      preferences,
      capabilities: {
        infoSubscriptions: true,
        noteStatusAlerts: true,
        dailyDigest: false,
      },
    }));
  }

  @Patch('preferences')
  @ApiOperation({ summary: '更新助手的用户级设置(与圈子订阅无关)' })
  updatePreferences(
    @Req() req: RequestWithUser,
    @Body() dto: UpdateAssistantPreferencesDto,
  ) {
    return this.assistant.updatePreferences(req.user.userId, dto);
  }

  @Get('subscriptions')
  listSubscriptions(@Req() req: RequestWithUser) {
    return this.subscriptions.list(req.user.userId);
  }

  @Post('subscriptions')
  createSubscription(
    @Req() req: RequestWithUser,
    @Body() dto: CreateAssistantSubscriptionDto,
  ) {
    return this.subscriptions.create(req.user.userId, dto);
  }

  @Patch('subscriptions/:id')
  updateSubscription(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
    @Body() dto: UpdateAssistantSubscriptionDto,
  ) {
    return this.subscriptions.update(req.user.userId, id, dto);
  }

  @Delete('subscriptions/:id')
  async removeSubscription(
    @Req() req: RequestWithUser,
    @Param('id') id: string,
  ) {
    await this.subscriptions.remove(req.user.userId, id);
    return { ok: true };
  }
}
