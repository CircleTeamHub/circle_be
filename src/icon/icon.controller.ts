import {
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  DisplayIconDto,
  IconOptionsResponseDto,
  UpdateDisplayIconsDto,
} from './dto/icon.dto';
import { IconService } from './icon.service';

@ApiTags('Icon')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('icon')
export class IconController {
  constructor(private readonly iconService: IconService) {}

  @Get('options')
  @ApiOperation({ summary: 'Get all eligible user icons and current selections' })
  @ApiOkResponse({ type: IconOptionsResponseDto })
  options(@Req() req: any) {
    return this.iconService.getIconOptions(req.user.userId);
  }

  @Put('display')
  @ApiOperation({ summary: 'Update currently displayed user icons' })
  @ApiOkResponse({ type: [DisplayIconDto] })
  updateDisplay(@Req() req: any, @Body() dto: UpdateDisplayIconsDto) {
    return this.iconService.updateDisplayIcons(req.user.userId, dto.items);
  }
}
