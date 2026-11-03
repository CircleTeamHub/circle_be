import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { CreateStickerDto } from './sticker.dto';
import { StickerService } from './sticker.service';

@ApiTags('stickers')
@ApiBearerAuth()
@UseGuards(JwtGuard, ThrottlerGuard)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
@Controller('stickers')
export class StickerController {
  constructor(private readonly service: StickerService) {}
  @Get()
  list(@Req() req: RequestWithUser) {
    return this.service.list(req.user.userId);
  }
  @Post()
  create(@Req() req: RequestWithUser, @Body() dto: CreateStickerDto) {
    return this.service.create(req.user.userId, dto);
  }
  @Delete(':id')
  @HttpCode(204)
  remove(@Req() req: RequestWithUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(req.user.userId, id);
  }
  @Post(':id/message-media')
  prepareMessage(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.prepareMessage(req.user.userId, id);
  }
}
