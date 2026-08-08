import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import { TempChatErrorCode } from 'src/common/app-error-codes';
import { ChatService } from 'src/chat/chat.service';
import { HistoryQueryDto } from 'src/chat/dto/history-query.dto';
import { UploadService } from 'src/upload/upload.service';
import { PresignDto } from 'src/upload/dto/presign.dto';
import { CreateTempChatDto } from './dto/create-temp-chat.dto';
import { JoinTempChatDto } from './dto/join-temp-chat.dto';
import {
  TempChatGuestGuard,
  type RequestWithTempChatGuest,
} from './temp-chat-guest.guard';
import { TempChatService } from './temp-chat.service';

@ApiTags('Temp Chat')
@Controller('temp-chat')
@UseGuards(ThrottlerGuard)
export class TempChatController {
  constructor(
    private readonly service: TempChatService,
    private readonly chatService: ChatService,
    private readonly uploadService: UploadService,
  ) {}

  @Post()
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建临时聊天（发起人）' })
  create(@Req() req: any, @Body() dto: CreateTempChatDto) {
    return this.service.create(req.user.userId, dto);
  }

  @Get('mine')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '发起人的临时聊天列表' })
  listMine(@Req() req: any) {
    return this.service.listMine(req.user.userId);
  }

  // 公开端点：靠 link JWT + 限流保护。token 非法 → 404。
  @Post('by-token/:token/meta')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '落地页：获取房间元信息' })
  async meta(@Param('token') token: string) {
    try {
      return await this.service.getByToken(token);
    } catch (err: any) {
      if (
        err?.name === 'JsonWebTokenError' ||
        err?.name === 'TokenExpiredError'
      ) {
        throw new NotFoundException({
          message: '链接无效',
          errorCode: TempChatErrorCode.LinkInvalid,
        });
      }
      throw err;
    }
  }

  @Post('by-token/:token/join')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '访客免注册加入' })
  async join(@Param('token') token: string, @Body() dto: JoinTempChatDto) {
    try {
      return await this.service.join(token, dto);
    } catch (err: any) {
      if (
        err?.name === 'JsonWebTokenError' ||
        err?.name === 'TokenExpiredError'
      ) {
        throw new NotFoundException({
          message: '链接无效',
          errorCode: TempChatErrorCode.LinkInvalid,
        });
      }
      throw err;
    }
  }

  // 访客历史(冷路径):Bearer 访客聊天凭证;实时走 /chat-ws 二形态握手。
  @Get('guest/messages')
  @UseGuards(TempChatGuestGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '访客拉取房间历史(height 键集分页)' })
  guestHistory(
    @Req() req: RequestWithTempChatGuest,
    @Query() query: HistoryQueryDto,
  ) {
    return this.chatService.getHistory(
      req.tempChatGuest.guestId,
      req.tempChatGuest.conversationId,
      query.beforeHeight,
      query.limit,
    );
  }

  // 访客成员目录(冷路径):访客页成员面板用,房主由 isHost 标出。
  @Get('guest/members')
  @UseGuards(TempChatGuestGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '访客拉取房间成员目录' })
  guestMembers(@Req() req: RequestWithTempChatGuest) {
    return this.service.listGuestMembers(req.tempChatGuest);
  }

  // 访客发图:presign 归 chat 目录,key 以 guestId 命名空间(所有权可校验)。
  @Post('guest/upload-presign')
  @UseGuards(TempChatGuestGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '访客图片上传预签名' })
  guestUploadPresign(
    @Req() req: RequestWithTempChatGuest,
    @Body() dto: PresignDto,
  ) {
    return this.uploadService.presign(
      dto.filename,
      dto.contentType,
      dto.sizeBytes,
      'chat',
      req.tempChatGuest.guestId,
    );
  }

  @Post(':id/end')
  @UseGuards(JwtGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发起人手动结束' })
  end(@Req() req: any, @Param('id') id: string) {
    return this.service.end(req.user.userId, id);
  }
}
