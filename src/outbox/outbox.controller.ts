import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { OutboxService } from './outbox.service';

@ApiTags('Outbox')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('outbox')
export class OutboxController {
  constructor(private readonly outboxService: OutboxService) {}

  @Get('health')
  @ApiOperation({ summary: 'Get friend/group OpenIM outbox health' })
  @ApiOkResponse({ description: 'Outbox status summary' })
  getHealth() {
    return this.outboxService.getHealth();
  }
}
