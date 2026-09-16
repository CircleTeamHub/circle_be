import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { TempChatErrorCode } from 'src/common/app-error-codes';
import { HistoryQueryDto } from 'src/chat/dto/history-query.dto';
import { UploadService } from 'src/upload/upload.service';
import { UploadErrorCode } from 'src/common/app-error-codes';
import { CreateTempChatDto } from './dto/create-temp-chat.dto';
import {
  GuestPresignDto,
  GUEST_IMAGE_MAX_BYTES,
} from './dto/guest-presign.dto';
import { JoinTempChatDto } from './dto/join-temp-chat.dto';
import {
  TempChatGuestGuard,
  type RequestWithTempChatGuest,
} from './temp-chat-guest.guard';
import { TempChatService } from './temp-chat.service';
import { TempChatUploadQuota } from './temp-chat-upload-quota';

@ApiTags('Temp Chat')
@Controller('temp-chat')
@UseGuards(ThrottlerGuard)
export class TempChatController {
  constructor(
    private readonly service: TempChatService,
    private readonly uploadService: UploadService,
    private readonly uploadQuota: TempChatUploadQuota,
  ) {}

  @Post()
  @UseGuards(JwtGuard, AppAudienceGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '创建临时聊天（发起人）' })
  create(@Req() req: any, @Body() dto: CreateTempChatDto) {
    return this.service.create(req.user.userId, dto);
  }

  @Get('mine')
  @UseGuards(JwtGuard, AppAudienceGuard)
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
    return this.service.getGuestHistory(req.tempChatGuest, query);
  }

  // 访客成员目录(冷路径):访客页成员面板用,房主由 isHost 标出。
  @Get('guest/members')
  @UseGuards(TempChatGuestGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '访客拉取房间成员目录' })
  guestMembers(@Req() req: RequestWithTempChatGuest) {
    return this.service.listGuestMembers(req.tempChatGuest);
  }

  @Get('guest/messages/:messageId/note')
  @UseGuards(TempChatGuestGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '访客读取本房间笔记卡片的只读详情' })
  guestNote(
    @Req() req: RequestWithTempChatGuest,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ) {
    return this.service.getGuestNote(req.tempChatGuest, messageId);
  }

  // 访客发图片/视频:presign 归 chat 目录,key 以 guestId 命名空间(所有权可校验)。
  // 匿名访客使用独立的格式/单文件上限,次数限流之外再走累计字节配额。
  @Post('guest/upload-presign')
  @UseGuards(TempChatGuestGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: '访客聊天媒体上传预签名',
    description:
      'chat 是私有目录：对象直连会被拒绝，fileUrl 固定为 null。' +
      '访客端只保存 key，读取由聊天媒体读路径按 key 签发短时 GET URL。',
  })
  async guestUploadPresign(
    @Req() req: RequestWithTempChatGuest,
    @Body() dto: GuestPresignDto,
  ) {
    // 全仓错误响应统一是 {message, errorCode} 信封(all-exception.filter 依赖它,
    // 客户端按 errorCode 本地化)。裸字符串会退化成无 code 的 message,访客页
    // 只能原样展示服务端中文。
    if (
      dto.contentType.startsWith('image/') &&
      dto.sizeBytes > GUEST_IMAGE_MAX_BYTES
    ) {
      throw new BadRequestException({
        message: '图片不能超过 10MB',
        errorCode: UploadErrorCode.PayloadTooLarge,
      });
    }
    await this.uploadQuota.consume(
      req.tempChatGuest.guestId,
      req.tempChatGuest.tcId,
      dto.sizeBytes,
    );
    return this.uploadService.presign(
      dto.filename,
      dto.contentType,
      dto.sizeBytes,
      'chat',
      req.tempChatGuest.guestId,
    );
  }

  @Post(':id/end')
  @UseGuards(JwtGuard, AppAudienceGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '发起人手动结束' })
  end(@Req() req: any, @Param('id') id: string) {
    return this.service.end(req.user.userId, id);
  }
}
