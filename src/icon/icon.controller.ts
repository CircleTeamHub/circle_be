import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
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
  @ApiOperation({
    summary: 'Get all eligible user icons and current selections',
  })
  @ApiOkResponse({ type: IconOptionsResponseDto })
  options(@Req() req: any) {
    return this.iconService.getIconOptions(req.user.userId);
  }

  @Put('display')
  // 每次调用都是「删光当前全部展示图标 + createMany 重建 + 写一行用户表」，
  // 而这里原本没有任何路由级限流，只剩 300 次/分钟/IP 的全局兜底。
  // 按账号计数，理由同 user.controller 的 PATCH：别让 NAT 后的用户互相牵连。
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Update currently displayed user icons' })
  @ApiOkResponse({ type: [DisplayIconDto] })
  updateDisplay(@Req() req: any, @Body() dto: UpdateDisplayIconsDto) {
    return this.iconService.updateDisplayIcons(req.user.userId, dto.items);
  }
}
