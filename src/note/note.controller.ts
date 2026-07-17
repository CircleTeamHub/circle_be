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
  Query,
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
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  CollectNoteDto,
  CollectNoteResultDto,
  CreateNoteDto,
  CreateNoteExportDto,
  CreateNoteGroupDto,
  CreateNoteShareLinkDto,
  ListNoteShareLinksQueryDto,
  ListNotesQueryDto,
  NoteDetailDto,
  NoteExportResultDto,
  NoteGroupDto,
  NoteShareLinkDto,
  NoteSummaryDto,
  ReorderNoteGroupsDto,
  SetNoteAvailableDto,
  SetNoteStatusDto,
  SetPinnedDto,
  UpdateNoteDto,
  UpdateNoteGroupDto,
  UpdateNoteGroupIdsDto,
} from './dto/note.dto';
import { NoteService } from './note.service';

@ApiTags('Note')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('note')
export class NoteController {
  constructor(private readonly noteService: NoteService) {}

  @Get()
  @ApiOperation({ summary: 'My note list' })
  @ApiOkResponse({ type: [NoteSummaryDto] })
  listNotes(
    @Query() query: ListNotesQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteSummaryDto[]> {
    return this.noteService.listNotes(req.user.userId, query);
  }

  @Post()
  @ApiOperation({ summary: 'Create note' })
  @ApiOkResponse({ type: NoteDetailDto })
  createNote(
    @Body() dto: CreateNoteDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteDetailDto> {
    return this.noteService.createNote(req.user.userId, dto);
  }

  @Post('collect')
  @ApiOperation({
    summary: 'Collect a note from chat into my notes (snapshot copy)',
  })
  @ApiOkResponse({ type: CollectNoteResultDto })
  collectNote(
    @Body() dto: CollectNoteDto,
    @Req() req: RequestWithUser,
  ): Promise<CollectNoteResultDto> {
    return this.noteService.collectNote(req.user.userId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update note' })
  @ApiOkResponse({ type: NoteDetailDto })
  updateNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNoteDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteDetailDto> {
    return this.noteService.updateNote(req.user.userId, id, dto);
  }

  @Patch(':id/groups')
  @ApiOperation({ summary: 'Replace note group memberships only' })
  @ApiOkResponse({
    schema: { example: { id: 'uuid', groupIds: ['uuid-1', 'uuid-2'] } },
  })
  updateNoteGroupIds(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNoteGroupIdsDto,
    @Req() req: any,
  ) {
    return this.noteService.updateNoteGroupIds(
      req.user.userId,
      id,
      dto.groupIds,
    );
  }

  @Patch(':id/pin')
  @ApiOperation({ summary: 'Pin or unpin note' })
  @ApiOkResponse({ schema: { example: { id: 'uuid', pinned: true } } })
  setPinned(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetPinnedDto,
    @Req() req: RequestWithUser,
  ) {
    return this.noteService.setPinned(req.user.userId, id, dto.pinned);
  }

  @Patch(':id/available')
  @ApiOperation({ summary: 'Set note availability' })
  @ApiOkResponse({ schema: { example: { id: 'uuid', available: true } } })
  setAvailable(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetNoteAvailableDto,
    @Req() req: RequestWithUser,
  ) {
    return this.noteService.setAvailable(req.user.userId, id, dto.available);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Set note status' })
  @ApiOkResponse({ schema: { example: { id: 'uuid', status: 'UNLISTED' } } })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetNoteStatusDto,
    @Req() req: RequestWithUser,
  ) {
    return this.noteService.setStatus(req.user.userId, id, dto.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft delete note' })
  @ApiNoContentResponse()
  deleteNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.noteService.deleteNote(req.user.userId, id);
  }

  @Post('share-links')
  // Each call writes a new row with a unique token; throttle per-user/IP so a
  // client cannot spam unbounded share-link rows. Guard is applied here only —
  // ThrottlerModule is global but ThrottlerGuard is opt-in per route.
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create managed note share link' })
  @ApiOkResponse({ type: NoteShareLinkDto })
  createShareLink(
    @Body() dto: CreateNoteShareLinkDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteShareLinkDto> {
    return this.noteService.createShareLink(req.user.userId, dto);
  }

  // 必须声明在 @Get(':id') 之前：Nest 按声明顺序匹配，否则 /note/share-links 会
  // 先命中 @Get(':id')，被那条路由的 ParseUUIDPipe 当成非法 UUID 打成 400。
  @Get('share-links')
  @ApiOperation({ summary: 'My note share links (newest first, paginated)' })
  @ApiOkResponse({ type: [NoteShareLinkDto] })
  listShareLinks(
    @Query() query: ListNoteShareLinksQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteShareLinkDto[]> {
    return this.noteService.listShareLinks(req.user.userId, query);
  }

  /**
   * 吊销自己的分享链接。挂在 NoteController（类级 JwtGuard）而不是访客侧的
   * NoteShareLinkPublicController：吊销要校验 ownerID，必须先知道调用者是谁。
   *
   * 用 DELETE + 204 对齐同 controller 的 deleteNote / deleteGroup。语义上是软删除
   * （行还在，只是盖上 revokedAt），与 deleteNote 的软删除（status=DELETED）一致。
   * 重复吊销同样返回 204：吊销是幂等的。
   */
  @Delete('share-links/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke one of my note share links' })
  @ApiNoContentResponse()
  revokeShareLink(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.noteService.revokeShareLink(req.user.userId, id);
  }

  @Get('group')
  @ApiOperation({ summary: 'My note groups' })
  @ApiOkResponse({ type: [NoteGroupDto] })
  listGroups(@Req() req: RequestWithUser): Promise<NoteGroupDto[]> {
    return this.noteService.listGroups(req.user.userId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Note detail (own note, or any note marked available)',
  })
  @ApiOkResponse({ type: NoteDetailDto })
  getNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<NoteDetailDto> {
    return this.noteService.getNote(req.user.userId, id);
  }

  @Post(':id/exports')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a downloadable note export' })
  @ApiOkResponse({ type: NoteExportResultDto })
  createNoteExport(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateNoteExportDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteExportResultDto> {
    return this.noteService.createNoteExport(req.user.userId, id, dto);
  }

  @Post('group')
  @ApiOperation({ summary: 'Create note group' })
  @ApiOkResponse({ type: NoteGroupDto })
  createGroup(
    @Body() dto: CreateNoteGroupDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteGroupDto> {
    return this.noteService.createGroup(req.user.userId, dto);
  }

  @Patch('group/order')
  @ApiOperation({ summary: 'Reorder note groups' })
  @ApiOkResponse({ type: [NoteGroupDto] })
  reorderGroups(
    @Body() dto: ReorderNoteGroupsDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteGroupDto[]> {
    return this.noteService.reorderGroups(req.user.userId, dto.groupIds);
  }

  @Patch('group/:id')
  @ApiOperation({ summary: 'Rename note group' })
  @ApiOkResponse({ type: NoteGroupDto })
  updateGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNoteGroupDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteGroupDto> {
    return this.noteService.updateGroup(req.user.userId, id, dto);
  }

  @Delete('group/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete note group' })
  @ApiNoContentResponse()
  deleteGroup(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.noteService.deleteGroup(req.user.userId, id);
  }
}
