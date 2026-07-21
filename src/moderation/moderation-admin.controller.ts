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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ReportReviewStatus } from 'src/generated/prisma';
import { JwtGuard } from 'src/guards/jwt.guard';
import { AdminGuard } from 'src/guards/admin.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ModerationAdminService } from './moderation-admin.service';

class ListReportsQueryDto {
  @IsOptional()
  @IsEnum(ReportReviewStatus)
  status?: ReportReviewStatus;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}

class ReviewReportDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

class TakedownDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

function auditContext(req: RequestWithUser) {
  return {
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
  };
}

/**
 * 内容治理管理面（#92 / #93）：与 FriendReport 的 admin surface 同構。
 * 所有动作写 AdminAuditLog（#90，含 ip/userAgent/before-after）。
 */
@ApiTags('Admin · Moderation')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard)
@Controller('admin/moderation')
export class ModerationAdminController {
  constructor(private readonly service: ModerationAdminService) {}

  @Get('group-reports')
  @ApiOperation({ summary: 'List group reports (defaults to PENDING)' })
  listGroupReports(@Query() query: ListReportsQueryDto) {
    return this.service.listGroupReports(
      query.status ?? ReportReviewStatus.PENDING,
      query.page,
      query.limit,
    );
  }

  @Post('group-reports/:reportId/review')
  @ApiOperation({ summary: 'Approve or reject a pending group report' })
  reviewGroupReport(
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: ReviewReportDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.reviewGroupReport(
      req.user.userId,
      reportId,
      dto,
      auditContext(req),
    );
  }

  @Get('post-reports')
  @ApiOperation({ summary: 'List circle-post reports (defaults to PENDING)' })
  listPostReports(@Query() query: ListReportsQueryDto) {
    return this.service.listPostReports(
      query.status ?? ReportReviewStatus.PENDING,
      query.page,
      query.limit,
    );
  }

  @Post('post-reports/:reportId/review')
  @ApiOperation({ summary: 'Approve or reject a pending circle-post report' })
  reviewPostReport(
    @Param('reportId', ParseUUIDPipe) reportId: string,
    @Body() dto: ReviewReportDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.reviewPostReport(
      req.user.userId,
      reportId,
      dto,
      auditContext(req),
    );
  }

  @Post('posts/:postId/takedown')
  @ApiOperation({
    summary:
      'Take a circle post down (status → DELETED) — finer than banning the author',
  })
  takedownPost(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() dto: TakedownDto,
    @Req() req: RequestWithUser,
  ) {
    return this.service.takedownPost(
      req.user.userId,
      postId,
      dto.note,
      auditContext(req),
    );
  }

  @Post('posts/:postId/restore')
  @ApiOperation({ summary: 'Restore a taken-down circle post (→ ENDED)' })
  restorePost(
    @Param('postId', ParseUUIDPipe) postId: string,
    @Req() req: RequestWithUser,
  ) {
    return this.service.restorePost(req.user.userId, postId, auditContext(req));
  }
}
