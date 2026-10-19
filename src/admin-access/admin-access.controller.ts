import {
  Delete,
  Body,
  Post,
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
import {
  AdminAccountAvailabilityQuery,
  DeleteAdminAccountDto,
  CreateAdminAccountDto,
  ResetAdminPasswordDto,
  AdminPageQuery,
  UpdateAdminAccessDto,
  UpdateAdminNicknameDto,
} from './admin-access.dto';

@Controller('admin/access')
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
export class AdminAccessController {
  constructor(private readonly service: AdminAccessService) {}
  @Get('me')
  @RequireAdminPermission('USER_READ')
  me(@Req() req: RequestWithUser) {
    return this.service.getMine(req.user.userId);
  }
  @Patch('me/nickname')
  @RequireAdminPermission('USER_READ')
  updateNickname(
    @Req() req: RequestWithUser,
    @Body() dto: UpdateAdminNicknameDto,
  ) {
    return this.service.updateNickname(req.user.userId, dto.nickname);
  }

  @Post('accounts')
  @RequireAdminPermission('ACCESS_MANAGE')
  create(@Req() req: RequestWithUser, @Body() dto: CreateAdminAccountDto) {
    return this.service.create(req.user.userId, dto);
  }

  @Patch('accounts/:id/password')
  @RequireAdminPermission('ACCESS_MANAGE')
  resetPassword(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetAdminPasswordDto,
  ) {
    return this.service.resetPassword(req.user.userId, id, dto);
  }

  @Get('accounts/availability')
  @RequireAdminPermission('ACCESS_MANAGE')
  availability(@Query() query: AdminAccountAvailabilityQuery) {
    return this.service.availability(query);
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
  @Delete('accounts/:id')
  @RequireAdminPermission('ACCESS_MANAGE')
  remove(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeleteAdminAccountDto,
  ) {
    return this.service.remove(req.user.userId, id, dto);
  }
}
