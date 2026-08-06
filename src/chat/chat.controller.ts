import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ChatService } from './chat.service';
import { CreateDirectConversationDto } from './dto/create-direct-conversation.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import type { ChatConversationDto, ChatHistoryPageDto } from './chat.types';

/**
 * 自研聊天 REST 面:会话列表 / 建单聊 / 历史分页。
 * 实时收发走 /chat-ws socket;这里只承担冷路径(打开 App 时的全量拉取)。
 */
@Controller('chat')
@UseGuards(JwtGuard, ThrottlerGuard)
@ApiTags('Chat')
@ApiBearerAuth()
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Get('conversations')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '会话列表(带末条消息与未读数)' })
  listConversations(
    @Req() req: RequestWithUser,
  ): Promise<ChatConversationDto[]> {
    return this.chatService.listConversations(req.user.userId);
  }

  @Post('conversations/direct')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '取或建与某用户的单聊会话' })
  createDirectConversation(
    @Req() req: RequestWithUser,
    @Body() body: CreateDirectConversationDto,
  ): Promise<ChatConversationDto> {
    return this.chatService.getOrCreateDirectConversation(
      req.user.userId,
      body.peerUserId,
    );
  }

  @Get('conversations/:id/messages')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '会话历史(height 键集分页,页内升序)' })
  getHistory(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Query() query: HistoryQueryDto,
  ): Promise<ChatHistoryPageDto> {
    return this.chatService.getHistory(
      req.user.userId,
      conversationId,
      query.beforeHeight,
      query.limit,
    );
  }
}
