import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { ChatGroupAdminService } from './chat-group-admin.service';
import { ChatGroupEventService } from './chat-group-event.service';
import { ChatGroupSettingsService } from './chat-group-settings.service';
import { ChatService } from './chat.service';
import { ClearHistoryDto } from './dto/clear-history.dto';
import {
  GroupEventsQueryDto,
  SetGroupMemberRoleDto,
  SilenceGroupMemberDto,
} from './dto/group-admin.dto';
import {
  SetGroupAvatarDto,
  SetGroupMuteAllDto,
  SetGroupNoticeDto,
  TransferGroupOwnerDto,
  UpdateGroupPoliciesDto,
} from './dto/group-settings.dto';
import { ConversationPreferencesDto } from './dto/conversation-preferences.dto';
import { CreateCircleConversationDto } from './dto/create-circle-conversation.dto';
import { CreateDirectConversationDto } from './dto/create-direct-conversation.dto';
import {
  CreateGroupConversationDto,
  InviteGroupMembersDto,
  RenameGroupConversationDto,
} from './dto/group-conversation.dto';
import { GlobalSearchQueryDto } from './dto/global-search-query.dto';
import { SetBurnDurationDto } from './dto/set-burn-duration.dto';
import { HistoryQueryDto } from './dto/history-query.dto';
import { MessageDaysQueryDto } from './dto/message-days-query.dto';
import { MutationsQueryDto } from './dto/mutations-query.dto';
import type {
  ChatConversationDto,
  ChatGroupEventsPageDto,
  ChatGroupPoliciesDto,
  ChatHistoryPageDto,
  ChatMemberDto,
  ChatMemberSilenceDto,
  ChatMessageDto,
  ChatMutationsPageDto,
} from './chat.types';

/**
 * 自研聊天 REST 面:会话列表 / 建单聊 / 历史分页。
 * 实时收发走 /chat-ws socket;这里只承担冷路径(打开 App 时的全量拉取)。
 */
@Controller('chat')
// AppAudienceGuard:聊天是普通用户能力,管理台的 ADMIN token 不该能收发消息。
@UseGuards(JwtGuard, AppAudienceGuard, ThrottlerGuard)
@ApiTags('Chat')
@ApiBearerAuth()
export class ChatController {
  constructor(
    private readonly chatService: ChatService,
    private readonly groupAdmin: ChatGroupAdminService,
    private readonly groupEvents: ChatGroupEventService,
    private readonly groupSettings: ChatGroupSettingsService,
  ) {}

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

  @Post('conversations/group')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '创建独立群聊(不挂圈子;初始成员必须是好友)' })
  createGroupConversation(
    @Req() req: RequestWithUser,
    @Body() body: CreateGroupConversationDto,
  ): Promise<ChatConversationDto> {
    return this.chatService.createGroupConversation(req.user.userId, {
      name: body.name ?? null,
      memberIds: body.memberIds,
    });
  }

  @Post('conversations/:id/members')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '独立群聊:成员拉自己的好友进群' })
  inviteGroupMembers(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: InviteGroupMembersDto,
  ): Promise<ChatConversationDto> {
    return this.chatService.inviteToGroupConversation(
      req.user.userId,
      conversationId,
      body.memberIds,
    );
  }

  @Post('conversations/:id/leave')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '独立群聊:退出群聊(群主退群自动转移)' })
  leaveGroupConversation(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ): Promise<void> {
    return this.chatService.leaveGroupConversation(
      req.user.userId,
      conversationId,
    );
  }

  @Post('conversations/:id/dissolve')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: '独立群聊:群主解散(全员离座 + 全员聊天记录一并清空,不可逆)',
  })
  dissolveGroupConversation(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ): Promise<void> {
    return this.chatService.dissolveGroupConversation(
      req.user.userId,
      conversationId,
    );
  }

  @Patch('conversations/:id/name')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '独立群聊:改群名(任一在座成员)' })
  renameGroupConversation(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: RenameGroupConversationDto,
  ): Promise<ChatConversationDto> {
    return this.chatService.renameGroupConversation(
      req.user.userId,
      conversationId,
      body.name,
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

  @Get('messages/mutations')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: '离线期间的撤回/编辑增量(重连追平;撤回不改 height,补拉够不着)',
  })
  listMutations(
    @Req() req: RequestWithUser,
    @Query() query: MutationsQueryDto,
  ): Promise<ChatMutationsPageDto> {
    return this.chatService.listMutationsSince(
      req.user.userId,
      new Date(query.since),
      query.limit,
      query.sinceId,
    );
  }

  @Get('conversations/:id/members')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: '会话成员目录(GROUP 附角色与禁言状态)' })
  listMembers(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
  ): Promise<ChatMemberDto[]> {
    return this.chatService.listMembers(req.user.userId, conversationId);
  }

  @Get('conversations/:id/events')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary:
      '群日志(进退群/移出/角色/禁言/改名/公告/清空/转让),倒序游标分页;圈子群仅圈主/管理员',
  })
  listGroupEvents(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Query() query: GroupEventsQueryDto,
  ): Promise<ChatGroupEventsPageDto> {
    return this.groupEvents.listEvents(req.user.userId, conversationId, query);
  }

  @Patch('conversations/:id/members/:userId/role')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      '独立群聊:群主设/撤管理员(圈子群走 PATCH /group/:id/members/:userId/role)',
  })
  setGroupMemberRole(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() body: SetGroupMemberRoleDto,
  ): Promise<{ userId: string; role: 'ADMIN' | 'MEMBER' }> {
    return this.groupAdmin.setStandaloneMemberRole(
      req.user.userId,
      conversationId,
      targetUserId,
      body.role,
    );
  }

  @Delete('conversations/:id/members/:userId')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      '独立群聊:群主/管理员移出成员(管理员只能移普通成员;圈子群走 DELETE /group/:id/members/:userId)',
  })
  removeGroupMember(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ): Promise<void> {
    return this.groupAdmin.removeStandaloneMember(
      req.user.userId,
      conversationId,
      targetUserId,
    );
  }

  @Put('conversations/:id/members/:userId/silence')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      '禁言成员(两种群;群主/管理员;durationSec=null 直到解除;重复调用覆盖时长)',
  })
  silenceGroupMember(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
    @Body() body: SilenceGroupMemberDto,
  ): Promise<ChatMemberSilenceDto> {
    return this.groupAdmin.silenceMember(
      req.user.userId,
      conversationId,
      targetUserId,
      body.durationSec,
    );
  }

  @Delete('conversations/:id/members/:userId/silence')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '解除禁言(两种群;群主/管理员;未禁言时幂等)' })
  unsilenceGroupMember(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ): Promise<ChatMemberSilenceDto> {
    return this.groupAdmin.unsilenceMember(
      req.user.userId,
      conversationId,
      targetUserId,
    );
  }

  @Patch('conversations/:id/mute-all')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: '全员禁言开关(两种群;群主/管理员;管理员与群主豁免)',
  })
  setGroupMuteAll(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: SetGroupMuteAllDto,
  ): Promise<{ muteAll: boolean }> {
    return this.groupSettings.setMuteAll(
      req.user.userId,
      conversationId,
      body.enabled,
    );
  }

  @Post('conversations/:id/owner')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: '独立群聊:群主转让(新群主座位的管理员标记与禁言清零)',
  })
  transferGroupOwner(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: TransferGroupOwnerDto,
  ): Promise<void> {
    return this.groupSettings.transferOwnership(
      req.user.userId,
      conversationId,
      body.userId,
    );
  }

  @Patch('conversations/:id/notice')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: '独立群聊:群公告(群主/管理员;空串清空)' })
  setGroupNotice(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: SetGroupNoticeDto,
  ): Promise<{ notice: string | null }> {
    return this.groupSettings.setNotice(
      req.user.userId,
      conversationId,
      body.notice,
    );
  }

  @Patch('conversations/:id/avatar')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: '独立群聊:群头像(群主/管理员;URL 必须来自本应用存储)',
  })
  setGroupAvatar(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: SetGroupAvatarDto,
  ): Promise<{ avatarUrl: string }> {
    return this.groupSettings.setAvatar(
      req.user.userId,
      conversationId,
      body.avatarUrl,
    );
  }

  @Patch('conversations/:id/policies')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary:
      '群策略开关(两种群;群主/管理员):成员邀请 / 二维码入群 / 成员可查看资料 / 成员可加好友',
  })
  updateGroupPolicies(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: UpdateGroupPoliciesDto,
  ): Promise<ChatGroupPoliciesDto> {
    return this.groupSettings.updatePolicies(
      req.user.userId,
      conversationId,
      body,
    );
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
      query.timeZone,
    );
  }

  @Post('conversations/:id/burn')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: '会话级阅后即焚(任一方设置双方生效,变更留系统痕迹)',
  })
  setBurnDuration(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body: SetBurnDurationDto,
  ): Promise<{ burnDurationSec: number | null }> {
    return this.chatService.setBurnDuration(
      req.user.userId,
      conversationId,
      body.seconds ?? null,
    );
  }

  @Post('conversations/:id/clear')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: '清空聊天记录(默认仅本人;私聊成员或群主/管理员可显式全局生效)',
  })
  clearHistory(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Body() body?: ClearHistoryDto,
  ): Promise<{ clearedBeforeHeight: number }> {
    return this.chatService.clearHistory(
      req.user.userId,
      conversationId,
      body?.forEveryone ?? false,
      body?.targetHeight,
    );
  }

  @Get('conversations/:id/messages/:messageId/readers')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: '逐条已读回执:读者 = 已读水位 ≥ 该消息 height 的成员',
  })
  listMessageReaders(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) conversationId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
  ): Promise<{ readers: unknown[]; total: number }> {
    return this.chatService.listMessageReaders(
      req.user.userId,
      conversationId,
      messageId,
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
        afterHeight: query.afterHeight,
        tzEndOffsetMinutes: query.tzEndOffsetMinutes,
      },
    );
  }
}
