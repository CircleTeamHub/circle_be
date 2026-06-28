import {
  Controller,
  Delete,
  Param,
  ParseUUIDPipe,
  Post,
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
import { Serialize } from 'src/decorators/serialize.decorator';
import type { RequestWithUser } from 'src/auth/types';
import { LikeService } from './like.service';
import { LikeStatusDto } from './dto/like-status.dto';

@Controller('user')
@UseGuards(JwtGuard)
@ApiTags('User')
@ApiBearerAuth()
export class LikeController {
  constructor(private readonly likeService: LikeService) {}

  @Post(':id/like')
  @Serialize(LikeStatusDto)
  @ApiOperation({ summary: '给某用户点赞（每人对其每天最多一次）' })
  @ApiOkResponse({ description: '最新点赞状态', type: LikeStatusDto })
  like(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithUser) {
    return this.likeService.like(req.user.userId, id);
  }

  @Delete(':id/like')
  @Serialize(LikeStatusDto)
  @ApiOperation({ summary: '取消今天对某用户的点赞' })
  @ApiOkResponse({ description: '最新点赞状态', type: LikeStatusDto })
  unlike(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithUser) {
    return this.likeService.unlike(req.user.userId, id);
  }
}
