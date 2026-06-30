import {
  Body,
  Controller,
  DefaultValuePipe,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
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
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { JwtGuard } from 'src/guards/jwt.guard';
import type { RequestWithUser } from 'src/auth/types';
import { CirclePlazaService } from './circle-plaza.service';
import {
  CollaborationRecognitionResultDto,
  CreatePlazaPostDto,
  MyCirclePostDto,
  PlazaFeedQueryDto,
  PlazaPostDto,
  RecognizePostCollaboratorsDto,
  PostSignupItemDto,
} from './dto/circle-plaza.dto';

@ApiTags('Circle Plaza')
@ApiBearerAuth()
@UseGuards(ThrottlerGuard, JwtGuard)
@Controller('circle-plaza')
export class CirclePlazaController {
  constructor(private readonly plazaService: CirclePlazaService) {}

  @Get('feed')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Plaza feed (paginated, filterable by circle/city)',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many plaza feed reads' })
  feed(
    @Query() query: PlazaFeedQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<{
    items: PlazaPostDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    return this.plazaService.getFeed(req.user.userId, query);
  }

  @Post('posts')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Create a plaza post' })
  @ApiOkResponse({ type: PlazaPostDto })
  @ApiTooManyRequestsResponse({ description: 'Too many plaza post writes' })
  create(
    @Body() dto: CreatePlazaPostDto,
    @Req() req: RequestWithUser,
  ): Promise<PlazaPostDto> {
    return this.plazaService.createPost(req.user.userId, dto);
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

  @Get('posts/:id/signups')
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: 'List users who signed up for my post' })
  @ApiTooManyRequestsResponse({ description: 'Too many signup-list reads' })
  signups(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<{
    items: {
      id: string;
      nickname: string;
      avatarUrl: string | null;
      accountId: string;
      signedAt: string;
    }[];
  }> {
    return this.plazaService.getPostSignups(req.user.userId, id);
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
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
  ): Promise<{
    items: MyCirclePostDto[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    return this.plazaService.listMyPosts(req.user.userId, page);
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
  ): Promise<{ items: PostSignupItemDto[] }> {
    return this.plazaService.getMyPostSignups(req.user.userId, id);
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
