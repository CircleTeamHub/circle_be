import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
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
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  GroupMemberSyncResultDto,
  InviteGroupMembersDto,
} from './dto/group-member.dto';
import { ReportGroupDto } from './dto/group-report.dto';
import { GroupService } from './group.service';

@ApiTags('Group')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtGuard)
@Controller('group')
export class GroupController {
  constructor(private readonly groupService: GroupService) {}

  @Delete(':groupID/leave')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Clean up local group state after leaving a group' })
  @ApiNoContentResponse()
  @ApiTooManyRequestsResponse({ description: 'Too many group operations' })
  leaveGroup(
    @Param('groupID') groupID: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.groupService.leaveGroup(req.user.userId, groupID);
  }

  @Post(':groupID/members/invite')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({ summary: 'Invite group members with local state sync' })
  @ApiOkResponse({ type: GroupMemberSyncResultDto })
  @ApiTooManyRequestsResponse({ description: 'Too many group member invites' })
  inviteGroupMembers(
    @Param('groupID') groupID: string,
    @Body() dto: InviteGroupMembersDto,
    @Req() req: RequestWithUser,
  ): Promise<GroupMemberSyncResultDto> {
    return this.groupService.inviteGroupMembers(req.user.userId, groupID, dto);
  }

  @Delete(':groupID/members/:userID')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Remove a group member with local state sync' })
  @ApiOkResponse({ type: GroupMemberSyncResultDto })
  @ApiTooManyRequestsResponse({ description: 'Too many group member removals' })
  removeGroupMember(
    @Param('groupID') groupID: string,
    @Param('userID') userID: string,
    @Req() req: RequestWithUser,
  ): Promise<GroupMemberSyncResultDto> {
    return this.groupService.removeGroupMember(
      req.user.userId,
      groupID,
      userID,
    );
  }

  @Post(':groupID/report')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Submit a report against a group' })
  @ApiNoContentResponse()
  @ApiTooManyRequestsResponse({ description: 'Too many group reports' })
  reportGroup(
    @Param('groupID') groupID: string,
    @Body() dto: ReportGroupDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.groupService.reportGroup(req.user.userId, groupID, dto);
  }
}
