import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CreditService } from './credit.service';
import { CreditEventDto } from './dto/credit-event.dto';

@ApiTags('Credit')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('credit')
export class CreditController {
  constructor(private readonly creditService: CreditService) {}

  @Get('events')
  @ApiOperation({ summary: 'My recent credit score changes (last 50)' })
  @ApiOkResponse({ type: [CreditEventDto] })
  getEvents(@Req() req: RequestWithUser): Promise<CreditEventDto[]> {
    return this.creditService.getRecentEvents(req.user.userId);
  }
}
