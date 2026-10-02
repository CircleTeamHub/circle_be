import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import { AdminImService } from './admin-im.service';
import {
  ImListDto,
  ImMemberActionDto,
  ImMessageQueryDto,
} from './admin-im.dto';

@Controller('admin/im/conversations')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
export class AdminImController {
  constructor(private readonly service: AdminImService) {}
  @Get()
  @RequireAdminPermission('IM_READ')
  list(@Query() query: ImListDto) {
    return this.service.list(query);
  }
  @Post(':id/messages/query')
  @RequireAdminPermission('IM_READ')
  messages(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ImMessageQueryDto,
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    response.setHeader('Cache-Control', 'no-store');
    return this.service.messages(req.user.userId, id, dto);
  }
  @Get(':id/members')
  @RequireAdminPermission('IM_MODERATE')
  members(@Param('id', ParseUUIDPipe) id: string, @Query() query: ImListDto) {
    return this.service.members(id, query);
  }
  @Post(':id/members/:userId/actions')
  @RequireAdminPermission('IM_MODERATE')
  moderate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) target: string,
    @Body() dto: ImMemberActionDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.moderate(req.user.userId, id, target, dto);
  }
}
