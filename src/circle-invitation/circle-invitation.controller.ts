import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { CircleInvitationService } from './circle-invitation.service';
import {
  AddVerifierDto,
  InvitationDto,
  InviteToCircleDto,
  RespondVerificationDto,
} from './dto/circle-invitation.dto';

@ApiTags('Circle Invitation')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('circle-invitation')
export class CircleInvitationController {
  constructor(private readonly invitationService: CircleInvitationService) {}

  @Post('invite')
  @ApiOperation({
    summary: 'Invite a user to join a circle (starts 10-person verification)',
  })
  @ApiOkResponse({ type: InvitationDto })
  invite(
    @Body() dto: InviteToCircleDto,
    @Req() req: RequestWithUser,
  ): Promise<InvitationDto> {
    return this.invitationService.invite(
      req.user.userId,
      dto.applicantId,
      dto.circleId,
    );
  }

  @Get('pending')
  @ApiOperation({ summary: 'My pending verification requests (as verifier)' })
  @ApiOkResponse({ type: [InvitationDto] })
  myPendingVerifications(
    @Req() req: RequestWithUser,
  ): Promise<InvitationDto[]> {
    return this.invitationService.getMyPendingVerifications(req.user.userId);
  }

  @Get('my-applications')
  @ApiOperation({ summary: 'My applications (as applicant)' })
  @ApiOkResponse({ type: [InvitationDto] })
  myApplications(@Req() req: RequestWithUser): Promise<InvitationDto[]> {
    return this.invitationService.getMyApplications(req.user.userId);
  }

  @Get('circle/:circleId/pending')
  @ApiOperation({ summary: 'Pending invitations for a circle (admin only)' })
  @ApiOkResponse({ type: [InvitationDto] })
  circlePending(
    @Param('circleId', ParseUUIDPipe) circleId: string,
    @Req() req: RequestWithUser,
  ): Promise<InvitationDto[]> {
    return this.invitationService.getPendingInvitationsForCircle(
      req.user.userId,
      circleId,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get invitation detail with verifier slots' })
  @ApiOkResponse({ type: InvitationDto })
  getInvitation(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<InvitationDto> {
    return this.invitationService.getInvitationForViewer(req.user.userId, id);
  }

  @Post(':id/add-verifier')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Applicant adds a verifier (must be circle member)',
  })
  @ApiNoContentResponse()
  addVerifier(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddVerifierDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.invitationService.addVerifier(
      req.user.userId,
      id,
      dto.verifierId,
    );
  }

  @Post(':id/respond')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Verifier approves or rejects' })
  @ApiNoContentResponse()
  respond(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RespondVerificationDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.invitationService.respond(req.user.userId, id, dto.approve);
  }

  @Post(':id/admin-approve')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Owner/admin bypasses 10-person verification' })
  @ApiNoContentResponse()
  adminApprove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.invitationService.adminApprove(req.user.userId, id);
  }
}
