import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { SupportConfigDto } from './support.dto';
import { SupportService } from './support.service';

@ApiTags('Support')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get('config')
  @ApiOperation({ summary: '客服账号配置(App 运行时拉取)' })
  @ApiOkResponse({ type: SupportConfigDto })
  getConfig(): Promise<SupportConfigDto> {
    return this.support.getConfig();
  }
}
