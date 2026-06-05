import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  ChatHistoryMessagePageDto,
  ChatHistoryQueryDto,
} from './dto/chat-history.dto';
import { ChatHistoryService } from './chat-history.service';

@ApiTags('Chat History')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtGuard)
@Controller('chat-history')
export class ChatHistoryController {
  constructor(private readonly service: ChatHistoryService) {}

  @Get('conversations/:conversationID/messages')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Read restorable OpenIM history for a conversation' })
  @ApiOkResponse({ type: ChatHistoryMessagePageDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiNotFoundResponse({ description: 'Conversation not found or not visible' })
  @ApiTooManyRequestsResponse({ description: 'Too many history restore reads' })
  getMessages(
    @Req() req: RequestWithUser,
    @Param('conversationID') conversationID: string,
    @Query() query: ChatHistoryQueryDto,
  ) {
    return this.service.getMessages(
      req.user.userId,
      conversationID,
      query.limit ?? 100,
      query.beforeSeq,
    );
  }
}
