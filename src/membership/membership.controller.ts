import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  MembershipPlanDto,
  MembershipProgramStatusDto,
  MembershipStatusDto,
} from './dto/membership.dto';
import { MembershipService } from './membership.service';
import { MembershipProgramService } from './membership-program.service';

@ApiTags('Membership')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('membership')
export class MembershipController {
  constructor(
    private readonly membershipService: MembershipService,
    private readonly membershipProgram: MembershipProgramService,
  ) {}

  @Get('plans')
  @ApiOperation({ summary: 'List VIP membership plans' })
  @ApiOkResponse({ type: [MembershipPlanDto] })
  getPlans(): MembershipPlanDto[] {
    return this.membershipService.getPlans();
  }

  @Get('program')
  @ApiOperation({ summary: 'Get membership rollout status' })
  @ApiOkResponse({ type: MembershipProgramStatusDto })
  async getProgram(): Promise<MembershipProgramStatusDto> {
    const status = await this.membershipProgram.getStatus();
    return {
      enabled: status.enabled,
      enabledAt: status.enabledAt,
      entitlementFloorLevel: status.entitlementFloorLevel,
    };
  }

  @Get('me')
  @ApiOperation({ summary: 'Get effective membership for the current user' })
  @ApiOkResponse({ type: MembershipStatusDto })
  getMe(@Req() req: RequestWithUser): Promise<MembershipStatusDto> {
    return this.membershipService.getMe(req.user.userId);
  }
}
