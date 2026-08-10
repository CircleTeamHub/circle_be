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
@UseGuards(ThrottlerGuard, JwtGuard, AdminGuard)
@Controller('admin/community')
export class AdminCommunityController {
  constructor(private readonly community: AdminCommunityService) {}

  @Get('circles')
  @ApiOperation({ summary: 'List circles for administration' })
  @ApiOkResponse()
  listCircles(@Query() query: AdminCircleListQueryDto) {
    return this.community.listCircles(query);
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

  @Get('operations/:id')
  @ApiOperation({ summary: 'Get an admin group-operation status' })
  @ApiOkResponse()
  getOperation(@Param('id', ParseUUIDPipe) id: string) {
    return this.community.getOperation(id);
  }
}
