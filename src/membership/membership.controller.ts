import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  MembershipPlanDto,
  UpgradeMembershipDto,
  UpgradeMembershipResponseDto,
} from './dto/membership.dto';
import { MembershipService } from './membership.service';

@ApiTags('Membership')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('membership')
export class MembershipController {
  constructor(private readonly membershipService: MembershipService) {}

  @Get('plans')
  @ApiOperation({ summary: 'List VIP membership plans' })
  @ApiOkResponse({ type: [MembershipPlanDto] })
  getPlans(): MembershipPlanDto[] {
    return this.membershipService.getPlans();
  }

  @Post('upgrade')
  @ApiOperation({ summary: 'Upgrade current user VIP level with points' })
  @ApiOkResponse({ type: UpgradeMembershipResponseDto })
  upgrade(
    @Body() dto: UpgradeMembershipDto,
    @Req() req: any,
  ): Promise<UpgradeMembershipResponseDto> {
    return this.membershipService.upgrade(req.user.userId, dto.level);
  }
}
