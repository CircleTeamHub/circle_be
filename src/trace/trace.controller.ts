import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import { TraceService } from './trace.service';
import {
  CreateTraceCommentDto,
  CreateTraceDto,
  NewCountQueryDto,
  TraceCommentDto,
  TraceDto,
  TraceFeedQueryDto,
} from './dto/trace.dto';

@ApiTags('Trace (Moments)')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('trace')
export class TraceController {
  constructor(private readonly traceService: TraceService) {}

  @Get('feed')
  @ApiOperation({ summary: 'Friend moments feed' })
  feed(@Query() query: TraceFeedQueryDto, @Req() req: RequestWithUser) {
    return this.traceService.getFeed(req.user.userId, query);
  }

  @Get('feed/new-count')
  @ApiOperation({ summary: 'Count new moments since timestamp' })
  newCount(@Query() query: NewCountQueryDto, @Req() req: RequestWithUser) {
    return this.traceService.getNewCount(req.user.userId, query.since);
  }

  // NOTE: must stay AFTER the static `feed` / `feed/new-count` GET routes so
  // `:id` does not swallow them (NestJS/Express match in declaration order).
  @Get(':id')
  @ApiOperation({ summary: 'Get a single moment by id' })
  @ApiOkResponse({ type: TraceDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<TraceDto> {
    return this.traceService.getTraceById(req.user.userId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Post a moment' })
  @ApiOkResponse({ type: TraceDto })
  create(
    @Body() dto: CreateTraceDto,
    @Req() req: RequestWithUser,
  ): Promise<TraceDto> {
    return this.traceService.createTrace(req.user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete own moment' })
  @ApiNoContentResponse()
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.traceService.deleteTrace(req.user.userId, id);
  }

  @Post(':id/like')
  @ApiOperation({ summary: 'Toggle like on a moment' })
  like(@Param('id', ParseUUIDPipe) id: string, @Req() req: RequestWithUser) {
    return this.traceService.toggleLike(req.user.userId, id);
  }

  @Post(':id/comment')
  @ApiOperation({ summary: 'Comment on a moment' })
  @ApiOkResponse({ type: TraceCommentDto })
  comment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTraceCommentDto,
    @Req() req: RequestWithUser,
  ): Promise<TraceCommentDto> {
    return this.traceService.addComment(req.user.userId, id, dto);
  }

  @Delete('comment/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete own comment' })
  @ApiNoContentResponse()
  removeComment(
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.traceService.deleteComment(req.user.userId, commentId);
  }
}
