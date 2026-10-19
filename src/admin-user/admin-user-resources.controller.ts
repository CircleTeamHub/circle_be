import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import type { RequestWithUser } from 'src/auth/types';
import { AdminCommunityListQueryDto } from 'src/admin-community/admin-community.dto';
import { AdminUserResourcesService } from './admin-user-resources.service';
@ApiTags('Admin User Resources')
@ApiBearerAuth()
@Controller('admin/users/:userID')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
export class AdminUserResourcesController {
  constructor(private readonly service: AdminUserResourcesService) {}
  @Get('circles')
  @RequireAdminPermission('COMMUNITY_MANAGE')
  circles(
    @Param('userID', ParseUUIDPipe) id: string,
    @Query() q: AdminCommunityListQueryDto,
  ) {
    return this.service.circles(id, q);
  }
  @Get('groups')
  @RequireAdminPermission('COMMUNITY_MANAGE')
  groups(
    @Param('userID', ParseUUIDPipe) id: string,
    @Query() q: AdminCommunityListQueryDto,
  ) {
    return this.service.groups(id, q);
  }
  @Get('posts')
  @RequireAdminPermission('MODERATION_MANAGE')
  posts(
    @Param('userID', ParseUUIDPipe) id: string,
    @Query() q: AdminCommunityListQueryDto,
  ) {
    return this.service.posts(id, q);
  }
  @Get('notes')
  @RequireAdminPermission('MODERATION_MANAGE')
  notes(
    @Param('userID', ParseUUIDPipe) id: string,
    @Query() q: AdminCommunityListQueryDto,
  ) {
    return this.service.noteList(id, q);
  }
  @Get('posts/:id')
  @RequireAdminPermission('MODERATION_MANAGE')
  post(
    @Param('userID', ParseUUIDPipe) userID: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.post(userID, id, req.user);
  }
  @Get('notes/:id')
  @RequireAdminPermission('MODERATION_MANAGE')
  note(
    @Param('userID', ParseUUIDPipe) userID: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    return this.service.note(userID, id, req.user);
  }
}
