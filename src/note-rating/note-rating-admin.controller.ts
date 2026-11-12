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
import {
  AdminPermissionGuard,
  RequireAdminPermission,
} from 'src/admin-access/admin-permission.guard';
import type { RequestWithUser } from 'src/auth/types';
import { AdminGuard } from 'src/guards/admin.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import {
  ListNoteRatingCasesQueryDto,
  NoteRatingCaseDto,
  NoteRatingCaseListDto,
  ResolveNoteRatingCaseDto,
} from './dto/note-rating-admin.dto';
import { NoteRatingAdminService } from './note-rating-admin.service';

@ApiTags('Admin · Note ratings')
@ApiBearerAuth()
@UseGuards(JwtGuard, AdminGuard, AdminPermissionGuard)
@Controller('admin/note-ratings')
@RequireAdminPermission('MODERATION_MANAGE')
export class NoteRatingAdminController {
  constructor(private readonly service: NoteRatingAdminService) {}

  @Get('cases')
  @ApiOperation({
    summary: 'Burst and appeal review cases (defaults to PENDING), paginated',
  })
  @ApiOkResponse({ type: NoteRatingCaseListDto })
  list(
    @Query() query: ListNoteRatingCasesQueryDto,
  ): Promise<NoteRatingCaseListDto> {
    return this.service.listCases(query);
  }

  @Post('cases/:caseId/resolve')
  @ApiOperation({
    summary:
      'BURST: RELEASE or VOID (deducts credit). APPEAL: UPHOLD or REVOKE (deducts credit).',
  })
  @ApiOkResponse({ type: NoteRatingCaseDto })
  resolve(
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: ResolveNoteRatingCaseDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteRatingCaseDto> {
    return this.service.resolveCase(req.user.userId, caseId, dto);
  }
}
