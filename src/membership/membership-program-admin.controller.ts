import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import { Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { EnableMembershipProgramResponseDto } from './dto/membership.dto';
import { MembershipProgramService } from './membership-program.service';

@ApiTags('Admin · Memberships')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
@Controller('admin/memberships/program')
@RequireAdminPermission('COMMERCE_MANAGE')
export class MembershipProgramAdminController {
  constructor(private readonly membershipProgram: MembershipProgramService) {}

  @Post('enable')
  @ApiOperation({ summary: 'Permanently enable membership enforcement' })
  @ApiCreatedResponse({ type: EnableMembershipProgramResponseDto })
  enable(
    @Req() req: RequestWithUser,
  ): Promise<EnableMembershipProgramResponseDto> {
    return this.membershipProgram.enable(req.user.userId);
  }
}
