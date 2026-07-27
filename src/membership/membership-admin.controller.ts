import {
  Body,
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  CreateMembershipGrantDto,
  MembershipAdminGrantResponseDto,
} from './dto/membership.dto';
import { MembershipAdminService } from './membership-admin.service';

@ApiTags('Admin · Memberships')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/memberships/users')
export class MembershipAdminController {
  constructor(
    private readonly membershipAdminService: MembershipAdminService,
  ) {}

  @Post(':userId/grants')
  @ApiOperation({
    summary: 'Create an audited membership activation or upgrade',
  })
  @ApiCreatedResponse({ type: MembershipAdminGrantResponseDto })
  grant(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: CreateMembershipGrantDto,
    @Req() req: RequestWithUser,
  ): Promise<MembershipAdminGrantResponseDto> {
    return this.membershipAdminService.grant(req.user.userId, userId, dto);
  }
}
