import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  ChatHistoryMessagePageDto,
  ChatHistoryQueryDto,
} from './dto/chat-history.dto';
import { ChatHistoryService } from './chat-history.service';

@ApiTags('Chat History')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('chat-history')
export class ChatHistoryController {
  constructor(private readonly service: ChatHistoryService) {}

  @Get('conversations/:conversationID/messages')
  @ApiOperation({ summary: 'Read restorable OpenIM history for a conversation' })
  @ApiOkResponse({ type: ChatHistoryMessagePageDto })
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
