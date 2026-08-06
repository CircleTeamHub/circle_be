import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { ConversationPreferencesDto } from './dto/conversation-preferences.dto';
import { CreateCircleConversationDto } from './dto/create-circle-conversation.dto';
import { CreateDirectConversationDto } from './dto/create-direct-conversation.dto';
import { GlobalSearchQueryDto } from './dto/global-search-query.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { MessageDaysQueryDto } from './dto/message-days-query.dto';
import type {
  ChatConversationDto,
  ChatHistoryPageDto,
  ChatMemberDto,
  ChatMessageDto,
} from './chat.types';

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

  @Post('conversations/circle')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '取或建圈子群会话(仅 ACTIVE 圈成员)' })
  createCircleConversation(
    @Req() req: RequestWithUser,
    @Body() body: CreateCircleConversationDto,
  ): Promise<ChatConversationDto> {
    return this.chatService.getOrCreateCircleConversation(
      req.user.userId,
      body.circleId,
    );
  }

  @Patch('conversations/:id/preferences')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '会话偏好:置顶/免打扰' })
  setPreferences(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: ConversationPreferencesDto,
  ): Promise<ChatConversationDto> {
    return this.chatService.setConversationPreferences(
      req.user.userId,
      conversationId,
      body,
    );
  }

  @Get('messages/search')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '全局搜索:跨本人全部会话搜文本消息(最新在前)' })
  searchAllMessages(
    @Req() req: RequestWithUser,
    @Query() query: GlobalSearchQueryDto,
  ): Promise<ChatMessageDto[]> {
    return this.chatService.searchAllMessages(
      req.user.userId,
      query.keyword,
      query.limit,
    );
  }

  @Get('conversations/:id/members')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '会话成员目录(GROUP 附圈子角色)' })
  listMembers(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ): Promise<ChatMemberDto[]> {
    return this.chatService.listMembers(req.user.userId, conversationId);
  }

  @Get('conversations/:id/message-days')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: '某月内有聊天记录的日期集合(按日期日历上色)' })
  listMessageDays(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Query() query: MessageDaysQueryDto,
  ): Promise<string[]> {
    return this.chatService.listMessageDays(
      req.user.userId,
      conversationId,
      query.year,
      query.month,
      query.tzOffsetMinutes,
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
      {
        types: query.types,
        keyword: query.keyword,
        date: query.date,
        tzOffsetMinutes: query.tzOffsetMinutes,
      },
    );
  }
}
