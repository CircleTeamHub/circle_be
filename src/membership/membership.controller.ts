import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { MembershipPlanDto } from './dto/membership.dto';
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
}
