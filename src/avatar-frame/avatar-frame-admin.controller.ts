import {
  Body,
  Controller,
  Get,
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
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AvatarFrameAdminService } from './avatar-frame-admin.service';
import {
  AvatarFrameAdminInventoryQueryDto,
  CreateAvatarFrameGrantDto,
  RevokeAvatarFrameGrantDto,
} from './dto/avatar-frame-admin.dto';

function auditContext(req: RequestWithUser) {
  const userAgent = req.headers['user-agent'];
  return {
    ip: req.ip?.slice(0, 64) ?? null,
    userAgent:
      (Array.isArray(userAgent) ? userAgent[0] : userAgent)?.slice(0, 256) ??
      null,
  };
}

@ApiTags('Admin · Avatar frames')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/avatar-frames')
export class AvatarFrameAdminController {
  constructor(
    private readonly avatarFrameAdminService: AvatarFrameAdminService,
  ) {}

  @Get('assets')
  @ApiOperation({ summary: 'List active avatar-frame grant options' })
  @ApiOkResponse({ description: 'Active catalog in stable display order.' })
  listAssets() {
    return this.avatarFrameAdminService.listAssets();
  }

  @Get('users/:userId')
  @ApiOperation({
    summary: 'Get a user avatar-frame inventory and grant audit',
  })
  @ApiOkResponse({
    description:
      'Effective inventory, equipped frame, and paginated administrator grants.',
  })
  getUserInventory(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Query() query: AvatarFrameAdminInventoryQueryDto,
  ) {
    return this.avatarFrameAdminService.getUserInventory(userId, query);
  }

  @Post('users/:userId/grants')
  @ApiOperation({ summary: 'Grant an avatar frame to a user' })
  @ApiCreatedResponse({ description: 'Created or exactly replayed grant.' })
  grant(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: CreateAvatarFrameGrantDto,
    @Req() req: RequestWithUser,
  ) {
    return this.avatarFrameAdminService.grant(
      req.user.userId,
      userId,
      dto,
      auditContext(req),
    );
  }

  @Post('grants/:grantId/revoke')
  @ApiOperation({ summary: 'Revoke an administrator avatar-frame grant' })
  @ApiCreatedResponse({
    description: 'Revoked or exactly replayed revocation.',
  })
  revoke(
    @Param('grantId', ParseUUIDPipe) grantId: string,
    @Body() dto: RevokeAvatarFrameGrantDto,
    @Req() req: RequestWithUser,
  ) {
    return this.avatarFrameAdminService.revoke(
      req.user.userId,
      grantId,
      dto,
      auditContext(req),
    );
  }
}
