import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from './admin-permission.guard';
import { AdminAccessService } from './admin-access.service';
import { AdminPageQuery, UpdateAdminAccessDto } from './admin-access.dto';

@Controller('admin/access')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
export class AdminAccessController {
  constructor(private readonly service: AdminAccessService) {}
  @Get('me')
  @RequireAdminPermission('USER_READ')
  me(@Req() req: RequestWithUser) {
    return this.service.getMine(req.user.userId);
  }
  @Get('accounts')
  @RequireAdminPermission('ACCESS_MANAGE')
  list(@Query() query: AdminPageQuery) {
    return this.service.list(query);
  }
  @Patch('accounts/:id')
  @RequireAdminPermission('ACCESS_MANAGE')
  update(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAdminAccessDto,
  ) {
    return this.service.update(req.user.userId, id, dto);
  }
}
