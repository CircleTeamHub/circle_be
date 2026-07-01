import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CreditPolicyService } from './credit-policy.service';
import {
  CreditPolicyCheckDto,
  CreditPolicyDecisionDto,
} from './dto/credit-policy.dto';

@ApiTags('Credit')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('credit-policy')
export class CreditController {
  constructor(private readonly creditPolicyService: CreditPolicyService) {}

  @Post('check')
  @ApiOperation({
    summary: 'Check whether the current user can perform a credit-gated action',
  })
  @ApiOkResponse({ type: CreditPolicyDecisionDto })
  checkPolicy(
    @Req() req: RequestWithUser,
    @Body() dto: CreditPolicyCheckDto,
  ): Promise<CreditPolicyDecisionDto> {
    return this.creditPolicyService.check(req.user.userId, dto);
  }
}
