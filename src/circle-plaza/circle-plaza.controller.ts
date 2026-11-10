import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ClampPagePipe } from 'src/common/pagination';
import {
  IdempotencyScope,
  IdempotencyService,
} from 'src/idempotency/idempotency.service';
import { CirclePlazaService } from './circle-plaza.service';
import {
  CollaborationRecognitionResultDto,
  CreatePlazaPostDto,
  MyCirclePostDto,
  MyPostSignupsQueryDto,
  PlazaFeedQueryDto,
  PlazaFeedResponseDto,
  PlazaFeedSearchDto,
  PlazaPostDto,
  PlazaSeenDto,
  PlazaSeenResponseDto,
  RecognizePostCollaboratorsDto,
  ReportCirclePostDto,
  PostSignupItemDto,
  UpdatePlazaPostDto,
} from './dto/circle-plaza.dto';

@ApiTags('Circle Plaza')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtGuard)
@Controller('circle-plaza')
export class CirclePlazaController {
  constructor(
    private readonly plazaService: CirclePlazaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get('feed')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Plaza feed (paginated, filterable by circle/city)',
  })
  @ApiOkResponse({ type: PlazaFeedResponseDto })
  @ApiTooManyRequestsResponse({ description: 'Too many plaza feed reads' })
  feed(
    @Query() query: PlazaFeedQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<{
    items: PlazaPostDto[];
    total: number | null;
    page: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    return this.plazaService.getFeed(req.user.userId, query);
  }

  @Post('feed/search')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Plaza feed search with body-based city filters' })
  @ApiOkResponse({ type: PlazaFeedResponseDto })
  @ApiTooManyRequestsResponse({ description: 'Too many plaza feed reads' })
  feedSearch(
    @Body() body: PlazaFeedSearchDto,
    @Req() req: RequestWithUser,
  ): Promise<{
    items: PlazaPostDto[];
    total: number | null;
    page: number;
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    return this.plazaService.getFeed(req.user.userId, body);
  }

  @Post('posts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a plaza post' })
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOkResponse({ type: PlazaPostDto })
  @ApiTooManyRequestsResponse({ description: 'Too many plaza post writes' })
  create(
    @Body() dto: CreatePlazaPostDto,
    @Req() req: RequestWithUser,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PlazaPostDto> {
    return this.idempotency.run(
      {
        scope: IdempotencyScope.PlazaPostCreate,
        userId: req.user.userId,
        key: idempotencyKey,
        request: dto,
      },
      () => this.plazaService.createPost(req.user.userId, dto),
    );
  }

  @Get('posts/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Single post detail' })
  @ApiOkResponse({ type: PlazaPostDto })
  getPost(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<PlazaPostDto> {
    return this.plazaService.getPost(req.user.userId, id);
  }

  @Delete('posts/:id')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete own post (soft delete)' })
  @ApiNoContentResponse()
  @ApiTooManyRequestsResponse({ description: 'Too many plaza post writes' })
  deletePost(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.plazaService.deletePost(req.user.userId, id);
  }

  @Post('posts/:id/report')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Report a post' })
  @ApiTooManyRequestsResponse({ description: 'Too many report attempts' })
  reportPost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportCirclePostDto,
    @Req() req: RequestWithUser,
  ): Promise<{ reported: boolean }> {
    return this.plazaService.reportPost(req.user.userId, id, dto.reason);
  }

  @Post('posts/:id/signup')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Sign up for a post' })
  @ApiTooManyRequestsResponse({ description: 'Too many signup attempts' })
  signup(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<{ signed: boolean; signupCount: number }> {
    return this.plazaService.signupForPost(req.user.userId, id);
  }

  @Delete('posts/:id/signup')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Cancel signup for a post' })
  @ApiTooManyRequestsResponse({ description: 'Too many signup attempts' })
  cancelSignup(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<{ signed: boolean; signupCount: number }> {
    return this.plazaService.cancelSignup(req.user.userId, id);
  }

  // ─── Signup management (报名管理) — author-scoped ───────────────────────────

  @Get('me/posts')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'My circle posts with per-post unread signup counts',
  })
  @ApiTooManyRequestsResponse({
    description: 'Too many signup-management reads',
  })
  myPosts(
    @Req() req: RequestWithUser,
    // 这条没走 DTO，所以 @Max 管不到它 —— 用 ParseIntPipe 之后再夹一次，
    // 否则 ?page=100000000 依旧能强制 Postgres 扫完再把结果丢掉。
    @Query('page', new DefaultValuePipe(1), ParseIntPipe, ClampPagePipe)
    page: number,
  ): Promise<{
    items: MyCirclePostDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    return this.plazaService.listMyPosts(req.user.userId, page);
  }

  // Published apps acknowledge without a body and expect 204.
  @Post('seen')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Legacy plaza acknowledgement' })
  async seen(@Req() req: RequestWithUser): Promise<void> {
    await this.plazaService.markPlazaSeen(req.user.userId);
  }

  @Post('seen-through')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Acknowledge a successful feed snapshot and return remaining updates',
  })
  @ApiOkResponse({ type: PlazaSeenResponseDto })
  @ApiTooManyRequestsResponse({ description: 'Too many plaza seen writes' })
  seenThrough(
    @Body() dto: PlazaSeenDto,
    @Req() req: RequestWithUser,
  ): Promise<PlazaSeenResponseDto> {
    return this.plazaService.markPlazaSeen(req.user.userId, dto.snapshotAt);
  }

  @Get('me/signups/unread-count')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Unread signup count across my posts (red dot)' })
  @ApiTooManyRequestsResponse({
    description: 'Too many signup-management reads',
  })
  mySignupsUnread(@Req() req: RequestWithUser): Promise<{ count: number }> {
    return this.plazaService.getMySignupsUnreadCount(req.user.userId);
  }

  @Get('me/posts/:id')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Details of my post, including ended activities' })
  @ApiOkResponse({ type: PlazaPostDto })
  myPost(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<PlazaPostDto> {
    return this.plazaService.getMyPost(req.user.userId, id);
  }

  @Patch('me/posts/:id')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Edit the content of my post' })
  @ApiNoContentResponse()
  updateMyPost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePlazaPostDto,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.plazaService.updateMyPost(req.user.userId, id, dto);
  }

  @Get('me/posts/:id/signups')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Signers of my post (with identity to start a chat)',
  })
  @ApiOkResponse({ type: PostSignupItemDto, isArray: true })
  @ApiTooManyRequestsResponse({
    description: 'Too many signup-management reads',
  })
  myPostSignups(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
    @Query() query: MyPostSignupsQueryDto,
  ): Promise<{
    items: PostSignupItemDto[];
    recognitionOpen: boolean;
    hasMore: boolean;
  }> {
    return this.plazaService.getMyPostSignups(req.user.userId, id, query.limit);
  }

  @Post('me/posts/:id/signups/read')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'Mark my post signups as read' })
  @ApiTooManyRequestsResponse({
    description: 'Too many signup-management writes',
  })
  readMyPostSignups(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<{ count: number }> {
    return this.plazaService.markPostSignupsSeen(req.user.userId, id);
  }

  @Post('me/posts/:id/collaboration-recognitions')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recognize up to three signup collaborators for my post',
  })
  @ApiOkResponse({ type: CollaborationRecognitionResultDto })
  @ApiTooManyRequestsResponse({
    description: 'Too many collaboration-recognition writes',
  })
  recognizePostCollaborators(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecognizePostCollaboratorsDto,
    @Req() req: RequestWithUser,
  ): Promise<CollaborationRecognitionResultDto> {
    return this.plazaService.recognizePostCollaborators(
      req.user.userId,
      id,
      dto.recipientIds,
    );
  }
}
