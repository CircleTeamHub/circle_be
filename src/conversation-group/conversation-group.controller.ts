import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ConversationGroupService } from './conversation-group.service';
import {
  ConversationGroupDto,
  CreateConversationGroupDto,
  SetConversationGroupMembersDto,
  UpdateConversationGroupDto,
} from './dto/conversation-group.dto';

@ApiTags('Conversation Group')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('conversation-groups')
export class ConversationGroupController {
  constructor(private readonly service: ConversationGroupService) {}

  @Get()
  @ApiOperation({ summary: 'List all conversation groups owned by current user' })
  @ApiOkResponse({ type: [ConversationGroupDto] })
  list(@Req() req: any) {
    return this.service.list(req.user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new conversation group' })
  @ApiOkResponse({ type: ConversationGroupDto })
  create(@Req() req: any, @Body() dto: CreateConversationGroupDto) {
    return this.service.create(req.user.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename or toggle pinnedToTabs / sortOrder' })
  @ApiOkResponse({ type: ConversationGroupDto })
  update(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationGroupDto,
  ) {
    return this.service.update(req.user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a conversation group (memberships cascade)' })
  @ApiNoContentResponse()
  remove(@Req() req: any, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.remove(req.user.userId, id);
  }

  @Put(':id/members')
  @ApiOperation({
    summary:
      'Replace the entire membership list with the given conversationIDs. Idempotent (last-write-wins).',
  })
  @ApiOkResponse({ type: ConversationGroupDto })
  setMembers(
    @Req() req: any,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetConversationGroupMembersDto,
  ) {
    return this.service.setMembers(req.user.userId, id, dto);
  }
}
