import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  AdminCircleListQueryDto,
  AdminCommunityListQueryDto,
  AdminConfirmedActionDto,
  AdminGroupOperationDto,
  requireIdempotencyKey,
} from './admin-community.dto';
import { AdminCommunityService } from './admin-community.service';

@ApiTags('Admin - Community')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtGuard, AdminGuard, AdminPermissionGuard)
@Controller('admin/community')
@RequireAdminPermission('COMMUNITY_MANAGE')
export class AdminCommunityController {
  constructor(private readonly community: AdminCommunityService) {}

  @Get('circles')
  @ApiOperation({ summary: 'List circles for administration' })
  @ApiOkResponse()
  listCircles(@Query() query: AdminCircleListQueryDto) {
    return this.community.listCircles(query);
  }

  @Get('circles/:id')
  @ApiOperation({ summary: '圈子完整详情（含 App 资料与管理状态）' })
  circleDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.community.circleDetail(id);
  }

  @Get('circles/:id/members')
  @ApiOperation({ summary: '分页查看圈子成员及申请状态' })
  circleMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminCommunityListQueryDto,
  ) {
    return this.community.circleMembers(id, query);
  }

  @Get('circles/:id/posts')
  @ApiOperation({ summary: '分页查看圈子全部动态（含关联发布）' })
  circlePosts(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminCommunityListQueryDto,
  ) {
    return this.community.circlePosts(id, query);
  }

  @Post('circles/:id/disable')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Disable a circle and mute its chat group' })
  @ApiCreatedResponse()
  disableCircle(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: AdminConfirmedActionDto,
    @Req() req: RequestWithUser,
  ) {
    return this.community.disableCircle({
      actorId: req.user.userId,
      circleId: id,
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      ...dto,
    });
  }

  @Post('circles/:id/restore')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Restore a circle and unmute its chat group' })
  @ApiCreatedResponse()
  restoreCircle(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: AdminConfirmedActionDto,
    @Req() req: RequestWithUser,
  ) {
    return this.community.restoreCircle({
      actorId: req.user.userId,
      circleId: id,
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      ...dto,
    });
  }

  @Get('groups')
  @ApiOperation({ summary: 'List all chat groups for administration' })
  @ApiOkResponse()
  listGroups(@Query() query: AdminCommunityListQueryDto) {
    return this.community.listGroups(query);
  }

  @Get('groups/:id')
  @ApiOperation({ summary: '查看群聊完整资料' })
  groupDetail(@Param('id', ParseUUIDPipe) id: string) {
    return this.community.groupDetail(id);
  }

  @Get('groups/:id/members')
  @ApiOperation({ summary: '查看群聊成员和离群记录' })
  groupMembers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminCommunityListQueryDto,
  ) {
    return this.community.groupMembers(id, query);
  }

  @Get('groups/:id/events')
  @ApiOperation({ summary: '查看群日志' })
  groupEvents(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AdminCommunityListQueryDto,
  ) {
    return this.community.groupEvents(id, query);
  }

  @Post('groups/:groupID/operations')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Mute, unmute, or permanently dismiss a group' })
  @ApiCreatedResponse()
  operateGroup(
    @Param('groupID') groupID: string,
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() dto: AdminGroupOperationDto,
    @Req() req: RequestWithUser,
  ) {
    return this.community.requestGroupOperation({
      actorId: req.user.userId,
      groupId: groupID,
      idempotencyKey: requireIdempotencyKey(idempotencyKey),
      ...dto,
    });
  }
}
