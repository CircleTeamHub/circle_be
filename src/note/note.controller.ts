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
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import {
  CreateNoteDto,
  CreateNoteGroupDto,
  ListNotesQueryDto,
  NoteDetailDto,
  NoteGroupDto,
  NoteSummaryDto,
  ReorderNoteGroupsDto,
  SetNoteAvailableDto,
  SetPinnedDto,
  UpdateNoteDto,
  UpdateNoteGroupDto,
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

  @Get('group')
  @ApiOperation({ summary: 'My note groups' })
  @ApiOkResponse({ type: [NoteGroupDto] })
  listGroups(@Req() req: RequestWithUser): Promise<NoteGroupDto[]> {
    return this.noteService.listGroups(req.user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'My note detail' })
  @ApiOkResponse({ type: NoteDetailDto })
  getNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<NoteDetailDto> {
    return this.noteService.getNote(req.user.userId, id);
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
