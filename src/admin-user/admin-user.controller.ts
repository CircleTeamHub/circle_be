import {
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminUserService } from './admin-user.service';
import {
  AdminUpdateUserStatusDto,
  ListAdminUsersQueryDto,
  RevealSensitiveFieldDto,
} from './dto/admin-user.dto';

@Controller('admin/users')
@UseGuards(JwtGuard, AdminGuard)
@ApiTags('Admin Users')
@ApiBearerAuth()
export class AdminUserController {
  constructor(private readonly service: AdminUserService) {}

  @Get()
  @ApiOperation({ summary: 'List and search users (admin only)' })
  list(@Query() query: ListAdminUsersQueryDto) {
    return this.service.listUsers(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get the Admin user 360 view' })
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getUserDetail(id);
  }

  @Post(':id/sensitive-access')
  @ApiOperation({ summary: 'Reveal one audited sensitive field' })
  reveal(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevealSensitiveFieldDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.revealSensitiveField(
      {
        userId: req.user.userId,
        accountId: req.user.accountId,
      },
      id,
      dto,
    );
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Ban, unban, or soft-delete a user' })
  updateStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateUserStatusDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.updateStatus(
      {
        userId: req.user.userId,
        accountId: req.user.accountId,
      },
      id,
      dto,
    );
  }

  @Get(':id/audit-logs')
  @ApiOperation({ summary: 'List recent Admin activity for a user' })
  auditLogs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    return this.service.listAuditLogs(id, limit);
  }
}
