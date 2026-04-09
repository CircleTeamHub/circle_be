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
import {
  AssignTagDto,
  BlockUserDto,
  CreateFriendTagDto,
  FriendProfileDto,
  FriendRequestDto,
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
  listFriends(@Req() req: any): Promise<FriendProfileDto[]> {
    return this.friendService.listFriends(req.user.userId);
  }

  @Delete(':friendUserId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a friend' })
  @ApiNoContentResponse()
  removeFriend(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.removeFriend(req.user.userId, friendUserId);
  }

  // ─── Remark ───────────────────────────────────────────────────────────────────

  @Patch(':friendUserId/remark')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Set or clear a private remark for a friend' })
  @ApiNoContentResponse()
  setRemark(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Body() dto: SetRemarkDto,
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.setRemark(req.user.userId, friendUserId, dto.remark ?? null);
  }

  // ─── Requests ────────────────────────────────────────────────────────────────

  @Post('requests')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Send a friend request' })
  @ApiNoContentResponse()
  sendRequest(@Body() dto: SendFriendRequestDto, @Req() req: any): Promise<void> {
    return this.friendService.sendRequest(req.user.userId, dto.targetId, dto.message);
  }

  @Get('requests/incoming')
  @ApiOperation({ summary: 'Incoming friend requests' })
  @ApiOkResponse({ type: [FriendRequestDto] })
  listIncoming(@Req() req: any): Promise<FriendRequestDto[]> {
    return this.friendService.listIncomingRequests(req.user.userId);
  }

  @Get('requests/outgoing')
  @ApiOperation({ summary: 'Outgoing friend requests' })
  @ApiOkResponse({ type: [FriendRequestDto] })
  listOutgoing(@Req() req: any): Promise<FriendRequestDto[]> {
    return this.friendService.listOutgoingRequests(req.user.userId);
  }

  @Post('requests/:requestId/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Accept a friend request' })
  @ApiNoContentResponse()
  acceptRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.handleRequest(req.user.userId, requestId, FriendState.ACCEPTED);
  }

  @Post('requests/:requestId/reject')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Reject a friend request' })
  @ApiNoContentResponse()
  rejectRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.handleRequest(req.user.userId, requestId, FriendState.REJECTED);
  }

  @Delete('requests/:requestId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Cancel an outgoing friend request' })
  @ApiNoContentResponse()
  cancelRequest(
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.cancelRequest(req.user.userId, requestId);
  }

  // ─── Relationship status ─────────────────────────────────────────────────────

  @Get('status/:targetId')
  @ApiOperation({ summary: 'Check relationship status with a user' })
  @ApiOkResponse({ type: FriendStatusDto })
  getStatus(
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Req() req: any,
  ): Promise<FriendStatusDto> {
    return this.friendService.getStatus(req.user.userId, targetId);
  }

  // ─── Friend tags ──────────────────────────────────────────────────────────────

  @Get('tags')
  @ApiOperation({ summary: 'My friend tags' })
  listTags(@Req() req: any) {
    return this.friendService.listMyTags(req.user.userId);
  }

  @Post('tags')
  @ApiOperation({ summary: 'Create a friend tag' })
  createTag(@Body() dto: CreateFriendTagDto, @Req() req: any) {
    return this.friendService.createTag(req.user.userId, dto.name, dto.color);
  }

  @Delete('tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a friend tag' })
  @ApiNoContentResponse()
  deleteTag(
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() req: any,
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
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.assignTag(req.user.userId, friendUserId, dto.tagId);
  }

  @Delete(':friendUserId/tags/:tagId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove a tag from a friend' })
  @ApiNoContentResponse()
  removeTag(
    @Param('friendUserId', ParseUUIDPipe) friendUserId: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.removeTag(req.user.userId, friendUserId, tagId);
  }

  @Get('tags/:tagId/friends')
  @ApiOperation({ summary: 'List friends under a tag' })
  @ApiOkResponse({ type: [FriendProfileDto] })
  listFriendsByTag(
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @Req() req: any,
  ): Promise<FriendProfileDto[]> {
    return this.friendService.listFriendsByTag(req.user.userId, tagId);
  }

  // ─── Block ────────────────────────────────────────────────────────────────────

  @Post('block')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Block a user' })
  @ApiNoContentResponse()
  blockUser(@Body() dto: BlockUserDto, @Req() req: any): Promise<void> {
    return this.friendService.blockUser(req.user.userId, dto.targetId);
  }

  @Delete('block/:targetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock a user' })
  @ApiNoContentResponse()
  unblockUser(
    @Param('targetId', ParseUUIDPipe) targetId: string,
    @Req() req: any,
  ): Promise<void> {
    return this.friendService.unblockUser(req.user.userId, targetId);
  }

  @Get('blocked')
  @ApiOperation({ summary: 'My blocked users list' })
  listBlocked(@Req() req: any) {
    return this.friendService.listBlocked(req.user.userId);
  }
}
