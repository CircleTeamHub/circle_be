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
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { FriendReportStatus } from 'src/generated/prisma';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  FriendReportAdminItemDto,
  ListFriendReportsQueryDto,
  ReviewFriendReportDto,
} from './dto/friend-report-admin.dto';
import { FriendReportAdminService } from './friend-report-admin.service';

@ApiTags('Admin · Friend Reports')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/friend-reports')
export class FriendReportAdminController {
  constructor(private readonly service: FriendReportAdminService) {}

  @Get()
  @ApiOperation({
    summary: 'List friend reports for review (defaults to PENDING)',
  })
  @ApiOkResponse({ type: [FriendReportAdminItemDto] })
  list(
    @Query() query: ListFriendReportsQueryDto,
  ): Promise<FriendReportAdminItemDto[]> {
    return this.service.listReports(query.status ?? FriendReportStatus.PENDING);
  }

  @Post(':reportId/review')
  @ApiOperation({
    summary: 'Approve (deduct credit) or reject a pending friend report',
  })
  @ApiOkResponse({ type: FriendReportAdminItemDto })
  review(
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: ReviewFriendReportDto,
    @Req() req: RequestWithUser,
  ): Promise<FriendReportAdminItemDto> {
    return this.service.reviewReport(req.user.userId, reportId, dto);
  }
}
