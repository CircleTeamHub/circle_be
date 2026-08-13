import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { MyReferralsDto, ReferralListQueryDto } from './dto/referral.dto';
import { ReferralService } from './referral.service';

@ApiTags('Referrals')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('referrals')
export class ReferralController {
  constructor(private readonly referrals: ReferralService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get my invite rules, progress, and referral list' })
  @ApiOkResponse({ type: MyReferralsDto })
  getMine(
    @Req() req: RequestWithUser,
    @Query() query: ReferralListQueryDto,
  ): Promise<MyReferralsDto> {
    return this.referrals.getMine(req.user.userId, query);
  }
}
