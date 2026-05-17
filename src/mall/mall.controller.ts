import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { MallSectionDto } from './dto/mall.dto';
import { MallService } from './mall.service';

@ApiTags('Mall')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('mall')
export class MallController {
  constructor(private readonly mallService: MallService) {}

  @Get('sections')
  @ApiOperation({ summary: 'List mall sections and products' })
  @ApiOkResponse({ type: [MallSectionDto] })
  getSections(): MallSectionDto[] {
    return this.mallService.getSections();
  }
}
