import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  IdempotencyScope,
  IdempotencyService,
} from 'src/idempotency/idempotency.service';
import {
  CollectNoteDto,
  CollectNoteResultDto,
  NoteSourceStateDto,
  NoteSourceStatesQueryDto,
  CopyNoteChatMediaDto,
  CreateNoteDto,
  CreateNoteExportDto,
  CreateNoteGroupDto,
  CreateNoteShareLinkDto,
  ListNoteShareLinksQueryDto,
  ListNotesQueryDto,
  ListNoteDraftsQueryDto,
  NoteChatMediaImportDto,
  NoteDetailDto,
  NoteDraftDto,
  NoteDraftSummaryDto,
  NoteExportResultDto,
  NoteGroupDto,
  NoteRankingDto,
  NoteRankingQueryDto,
  NoteShareLinkDto,
  NoteSummaryDto,
  ReorderNoteGroupsDto,
  SetNoteRemarkDto,
  SetNoteStatusDto,
  SetNoteSourceConversationDto,
  SetNoteWorkStatusDto,
  SetPinnedDto,
  SaveNoteDraftDto,
  UpdateNoteDto,
  UpdateNoteGroupDto,
  UpdateNoteGroupIdsDto,
} from './dto/note.dto';
import { NoteService } from './note.service';

/**
 * GET /note 的截断信号。app 依赖响应体是数组，「后面还有」
 * 只能走响应头而不能把响应体改成 { items, hasMore }。
 */
const HAS_MORE_HEADER = 'X-Has-More';
const HAS_MORE_DESCRIPTION =
  'The response body stays a JSON array. The `X-Has-More: true|false` response header ' +
  'reports whether more rows exist beyond this page (limit defaults to 500, max 500; ' +
  'request the next `page` to read them).';
const HAS_MORE_RESPONSE_HEADERS = {
  [HAS_MORE_HEADER]: {
    description: 'Whether more rows exist beyond this page',
    schema: { type: 'string', enum: ['true', 'false'] },
  },
};

@ApiTags('Note')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('note')
export class NoteController {
  constructor(
    private readonly noteService: NoteService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My note list', description: HAS_MORE_DESCRIPTION })
  @ApiOkResponse({
    type: [NoteSummaryDto],
    headers: HAS_MORE_RESPONSE_HEADERS,
  })
  async listNotes(
    @Query() query: ListNotesQueryDto,
    @Req() req: RequestWithUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<NoteSummaryDto[]> {
    const page = await this.noteService.listNotes(req.user.userId, query);
    res.setHeader(HAS_MORE_HEADER, String(page.hasMore));
    return page.items;
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

  @Post('source-states')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Live source status for note cards (root of the collect chain), batched',
  })
  @ApiOkResponse({ type: [NoteSourceStateDto] })
  getSourceStates(
    @Body() dto: NoteSourceStatesQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteSourceStateDto[]> {
    return this.noteService.getSourceStates(req.user.userId, dto.noteIds);
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
    @Req() req: RequestWithUser,
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

  @Patch(':id/remark')
  @ApiOperation({ summary: 'Set owner-only note remark' })
  @ApiOkResponse({ schema: { example: { id: 'uuid', remark: '重要客户' } } })
  setRemark(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetNoteRemarkDto,
    @Req() req: RequestWithUser,
  ) {
    return this.noteService.setRemark(req.user.userId, id, dto.remark ?? null);
  }

  @Patch(':id/work-status')
  @ApiOperation({
    summary: 'Set optional note work status (开工 / 打烊 / 下架)',
    description:
      'OFF_SHELF puts the note 下架 (status UNLISTED, workStatus null). WORKING / CLOSED on a 下架 note relists it (status ACTIVE). null only clears the label.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'uuid',
        status: 'ACTIVE',
        workStatus: 'WORKING',
        unlistedAt: null,
      },
    },
  })
  setWorkStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetNoteWorkStatusDto,
    @Req() req: RequestWithUser,
  ) {
    return this.noteService.setWorkStatus(
      req.user.userId,
      id,
      dto.workStatus ?? null,
    );
  }

  @Patch(':id/source-group')
  @ApiOperation({
    summary: 'Bind an owned note to a source group conversation',
  })
  @ApiOkResponse({
    schema: { example: { id: 'uuid', sourceConversationID: 'uuid' } },
  })
  setSourceConversation(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetNoteSourceConversationDto,
    @Req() req: RequestWithUser,
  ) {
    return this.noteService.setSourceConversation(
      req.user.userId,
      id,
      dto.conversationID ?? null,
    );
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Set note status (上架 / 下架)',
    description:
      'UNLISTED = 下架: still readable by others with its real status, permanently deleted 60 days after unlistedAt. Re-sending UNLISTED keeps unlistedAt; ACTIVE clears it.',
  })
  @ApiOkResponse({
    schema: {
      example: {
        id: 'uuid',
        status: 'UNLISTED',
        unlistedAt: '2026-11-13T12:00:00.000Z',
      },
    },
  })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetNoteStatusDto,
    @Req() req: RequestWithUser,
  ) {
    return this.noteService.setStatus(req.user.userId, id, dto.status);
  }

  // 必须先于 @Get(':id') 声明（同 share-links 的顺序注释）。
  @Get('source-group/:conversationId')
  @ApiOperation({
    summary: 'List the source notes bound to a group (read-only, members only)',
  })
  @ApiOkResponse({ type: [NoteSummaryDto] })
  listGroupBoundNotes(
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Req() req: RequestWithUser,
  ): Promise<NoteSummaryDto[]> {
    return this.noteService.listGroupBoundNotes(
      req.user.userId,
      conversationId,
    );
  }

  // 必须先于 @Get(':id') 声明（同 share-links 的顺序注释）。
  @Get('ranking')
  @ApiOperation({
    summary: 'Monthly 大众点评 ranking: notes with the most good ratings',
    description:
      'Current Shanghai month. Only ACTIVE + available source notes whose owner chose a city; `city` narrows to one city, absent = nationwide.',
  })
  @ApiOkResponse({ type: NoteRankingDto })
  getRanking(
    @Query() query: NoteRankingQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteRankingDto> {
    return this.noteService.getNoteRanking(req.user.userId, query);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete note permanently',
    description:
      'Not restorable. The note disappears for everyone at once; its rows are purged by the note cleanup job within minutes.',
  })
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
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: NoteShareLinkDto })
  createShareLink(
    @Body() dto: CreateNoteShareLinkDto,
    @Req() req: RequestWithUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<NoteShareLinkDto> {
    return this.idempotency.run(
      {
        scope: IdempotencyScope.NoteShareLinkCreate,
        userId: req.user.userId,
        key: idempotencyKey,
        request: dto,
      },
      () => this.noteService.createShareLink(req.user.userId, dto),
    );
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

  @Get('drafts')
  @ApiOperation({ summary: 'List my note drafts' })
  @ApiOkResponse({ type: [NoteDraftSummaryDto] })
  listDrafts(
    @Query() query: ListNoteDraftsQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteDraftSummaryDto[]> {
    return this.noteService.listNoteDrafts(
      req.user.userId,
      query.page ?? 1,
      query.limit ?? 100,
    );
  }

  @Get('drafts/:draftId')
  @ApiOperation({ summary: 'Get one of my note drafts' })
  @ApiOkResponse({ type: NoteDraftDto })
  getDraft(
    @Param('draftId') draftId: string,
    @Req() req: RequestWithUser,
  ): Promise<NoteDraftDto> {
    return this.noteService.getNoteDraft(req.user.userId, draftId);
  }

  @Put('drafts/:draftId')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create or update one of my note drafts' })
  @ApiOkResponse({ type: NoteDraftDto })
  saveDraft(
    @Param('draftId') draftId: string,
    @Body() dto: SaveNoteDraftDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteDraftDto> {
    return this.noteService.saveNoteDraft(req.user.userId, draftId, dto);
  }

  @Delete('drafts/:draftId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete one of my note drafts' })
  @ApiNoContentResponse()
  deleteDraft(
    @Param('draftId') draftId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.noteService.deleteNoteDraft(req.user.userId, draftId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Note detail (own note, or any ACTIVE note marked available)',
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

  // 把笔记指定分区的媒体复制进请求者 chat/{userId}/ 命名空间(供聊天发送)。
  // 限流:客户端批量上限一次 9 条笔记(每条一个请求),10/min 会让同一分钟内的
  // 第二批/重试必然 429、媒体静默丢失 —— 放到 20/min,配合服务内的复制并发上限
  // (NOTE_CHAT_MEDIA_COPY_CONCURRENCY)兜住对象存储压力。
  @Post(':id/chat-media')
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Copy note media into my chat namespace for sending',
  })
  @ApiOkResponse({ type: NoteChatMediaImportDto })
  copyNoteChatMedia(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CopyNoteChatMediaDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteChatMediaImportDto> {
    return this.noteService.copyNoteMediaForChat(
      req.user.userId,
      id,
      dto.sections,
    );
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
