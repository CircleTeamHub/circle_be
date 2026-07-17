import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { SharedNoteListDto } from './dto/note.dto';
import { NoteService } from './note.service';

/**
 * 分享链接的访客侧解析（`/s/{token}` 落地页的数据源）。
 *
 * 为什么单开一个 controller 而不是加到 NoteController 上：NoteController 是
 * **类级** `@UseGuards(JwtGuard)`，加进去的任何路由都会强制登录，而分享链接是
 * 二维码 / 系统分享出去的 web 链接，扫码的人没有 Circle 会话。同前缀公开
 * controller 的先例见 NotificationPublicController。
 *
 * 路由不与 NoteController 的 `@Get(':id')` 冲突：那条只吃单段路径（/note/xxx），
 * 这里是两段（/note/share-links/xxx）。
 */
@ApiTags('Note')
@Controller('note')
export class NoteShareLinkPublicController {
  constructor(private readonly noteService: NoteService) {}

  /**
   * 公开端点，刻意不挂 JwtGuard —— 凭据是 token 本身（18 字节随机数 = 144 bit，
   * 枚举不可行）。限流对齐 temp-chat 的访客落地页 `by-token/:token/meta`：
   * 30 次/分钟。注意 setup.ts 里 `app.use('/api/v1/note', noteWriteLimiter)` 是
   * Express 前缀挂载且不筛方法，本路由已被它覆盖（60 次/15 分钟/IP），
   * 这里的 @Throttle 是叠加的第二道，只作用于本路由。
   */
  @Get('share-links/:token')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '访客侧：解析分享链接（无需登录）' })
  @ApiOkResponse({ type: SharedNoteListDto })
  resolveShareLink(@Param('token') token: string): Promise<SharedNoteListDto> {
    return this.noteService.resolveShareLink(token);
  }
}
