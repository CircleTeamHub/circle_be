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
import { FriendState } from 'src/generated/prisma';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  AssignTagDto,
  BlockUserDto,
  FriendActivityDto,
  FriendActivityUnreadCountDto,
  FriendSettingsDto,
  CreateFriendTagDto,
  FriendProfileDto,
  FriendRequestDto,
  ReportFriendDto,
  FriendStatusDto,
  SendFriendRequestDto,
  SetRemarkDto,
} from './dto/friend.dto';
import { FriendService } from './friend.service';

@ApiTags('Friend')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('friend')
export class FriendController {
  constructor(private readonly friendService: FriendService) {}

  // ─── Friends ─────────────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: 'My friend list' })
  @ApiOkResponse({ type: [FriendProfileDto] })
  listFriends(@Req() req: RequestWithUser): Promise<FriendProfileDto[]> {
    return this.friendService.listFriends(req.user.userId);
  }

  @Get(':friendUserId/settings')
  @ApiOperation({ summary: 'Get editable settings for a friend' })
  @ApiOkResponse({ type: FriendSettingsDto })
  getFriendSettings(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Req() req: RequestWithUser,
  ): Promise<FriendSettingsDto> {
    return this.friendService.getFriendSettings(req.user.userId, friendUserId);
  }

  @Delete(':friendUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a friend' })
  @ApiNoContentResponse()
  removeFriend(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.removeFriend(req.user.userId, friendUserId);
  }

  @Post(':friendUserId/blacklist')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Add a friend to the blacklist' })
  @ApiNoContentResponse()
  blacklistFriend(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.blockUser(req.user.userId, friendUserId);
  }

  @Delete(':friendUserId/blacklist')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a friend from the blacklist' })
  @ApiNoContentResponse()
  removeFriendFromBlacklist(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.unblockUser(req.user.userId, friendUserId);
  }

  @Post(':friendUserId/report')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Submit a report against a friend' })
  @ApiNoContentResponse()
  reportFriend(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Body() dto: ReportFriendDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.reportFriend(req.user.userId, friendUserId, dto);
  }

  // ─── Remark ───────────────────────────────────────────────────────────────────

  @Patch(':friendUserId/remark')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set or clear a private remark for a friend' })
  @ApiNoContentResponse()
  setRemark(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Body() dto: SetRemarkDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.setRemark(
      req.user.userId,
      friendUserId,
      dto.remark ?? null,
    );
  }

  // ─── Requests ────────────────────────────────────────────────────────────────

  @Post('requests')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send a friend request' })
  @ApiNoContentResponse()
  sendRequest(
    @Body() dto: SendFriendRequestDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.sendRequest(
      req.user.userId,
      dto.targetId,
      dto.message,
      dto.remark,
      dto.tagIds,
      {
        description: dto.description,
        photos: dto.photos,
        permission: dto.permission,
      },
    );
  }

  @Get('requests/incoming')
  @ApiOperation({ summary: 'Incoming friend requests' })
  @ApiOkResponse({ type: [FriendRequestDto] })
  listIncoming(@Req() req: RequestWithUser): Promise<FriendRequestDto[]> {
    return this.friendService.listIncomingRequests(req.user.userId);
  }

  @Get('requests/outgoing')
  @ApiOperation({ summary: 'Outgoing friend requests' })
  @ApiOkResponse({ type: [FriendRequestDto] })
  listOutgoing(@Req() req: RequestWithUser): Promise<FriendRequestDto[]> {
    return this.friendService.listOutgoingRequests(req.user.userId);
  }

  @Post('requests/:requestId/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Accept a friend request' })
  @ApiNoContentResponse()
  acceptRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.handleRequest(
      req.user.userId,
      requestId,
      FriendState.ACCEPTED,
    );
  }

  @Post('requests/:requestId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reject a friend request' })
  @ApiNoContentResponse()
  rejectRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.handleRequest(
      req.user.userId,
      requestId,
      FriendState.REJECTED,
    );
  }

  @Delete('requests/:requestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel an outgoing friend request' })
  @ApiNoContentResponse()
  cancelRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.cancelRequest(req.user.userId, requestId);
  }

  @Get('activities')
  @ApiOperation({ summary: 'Friend activity inbox' })
  @ApiOkResponse({ type: [FriendActivityDto] })
  listActivities(@Req() req: RequestWithUser): Promise<FriendActivityDto[]> {
    return this.friendService.listActivities(req.user.userId);
  }

  @Get('activities/unread-count')
  @ApiOperation({ summary: 'Unread friend activity count' })
  @ApiOkResponse({ type: FriendActivityUnreadCountDto })
  getUnreadActivityCount(
    @Req() req: RequestWithUser,
  ): Promise<FriendActivityUnreadCountDto> {
    return this.friendService.getUnreadActivityCount(req.user.userId);
  }

  @Get('activities/:activityId')
  @ApiOperation({ summary: 'Friend activity detail' })
  @ApiOkResponse({ type: FriendActivityDto })
  getActivity(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Req() req: RequestWithUser,
  ): Promise<FriendActivityDto> {
    return this.friendService.getActivity(req.user.userId, activityId);
  }

  @Post('activities/:activityId/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Mark a single friend activity as read' })
  @ApiNoContentResponse()
  markActivityRead(
    @Param('activityId', ParseUUIDPipe) activityId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.markActivityRead(req.user.userId, activityId);
  }

  // ─── Relationship status ─────────────────────────────────────────────────────

  @Get('status/:targetId')
  @ApiOperation({ summary: 'Check relationship status with a user' })
  @ApiOkResponse({ type: FriendStatusDto })
  getStatus(
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Req() req: RequestWithUser,
  ): Promise<FriendStatusDto> {
    return this.friendService.getStatus(req.user.userId, targetId);
  }

  // ─── Friend tags ──────────────────────────────────────────────────────────────

  @Get('tags')
  @ApiOperation({ summary: 'My friend tags' })
  listTags(@Req() req: RequestWithUser) {
    return this.friendService.listMyTags(req.user.userId);
  }

  @Post('tags')
  @ApiOperation({
    summary: 'Create or update a friend tag (idempotent by name)',
    description:
      'Re-submitting an existing tag name updates its color instead of failing.',
  })
  createTag(@Body() dto: CreateFriendTagDto, @Req() req: RequestWithUser) {
    return this.friendService.createTag(req.user.userId, dto.name, dto.color);
  }

  @Delete('tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a friend tag' })
  @ApiNoContentResponse()
  deleteTag(
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.deleteTag(req.user.userId, tagId);
  }

  @Post(':friendUserId/tags')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Assign a tag to a friend' })
  @ApiNoContentResponse()
  assignTag(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Body() dto: AssignTagDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.assignTag(
      req.user.userId,
      friendUserId,
      dto.tagId,
    );
  }

  @Delete(':friendUserId/tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a tag from a friend' })
  @ApiNoContentResponse()
  removeTag(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.removeTag(req.user.userId, friendUserId, tagId);
  }

  @Get('tags/:tagId/friends')
  @ApiOperation({ summary: 'List friends under a tag' })
  @ApiOkResponse({ type: [FriendProfileDto] })
  listFriendsByTag(
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() req: RequestWithUser,
  ): Promise<FriendProfileDto[]> {
    return this.friendService.listFriendsByTag(req.user.userId, tagId);
  }

  // ─── Block ────────────────────────────────────────────────────────────────────

  @Post('block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Block a user' })
  @ApiNoContentResponse()
  blockUser(
    @Body() dto: BlockUserDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.blockUser(req.user.userId, dto.targetId);
  }

  @Delete('block/:targetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock a user' })
  @ApiNoContentResponse()
  unblockUser(
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.friendService.unblockUser(req.user.userId, targetId);
  }

  @Get('blocked')
  @ApiOperation({ summary: 'My blocked users list' })
  listBlocked(@Req() req: RequestWithUser) {
    return this.friendService.listBlocked(req.user.userId);
  }
}
