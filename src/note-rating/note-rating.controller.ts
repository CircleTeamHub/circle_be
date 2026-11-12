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
import { Throttle } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
  AppealNoteRatingDto,
  CreateNoteRatingDto,
  ListNoteBadRatingsQueryDto,
  NoteBadRatingDto,
  NoteBadRatingListDto,
  NoteRatingResultDto,
  NoteRatingSummaryDto,
} from './dto/note-rating.dto';
import { NoteRatingService } from './note-rating.service';

@ApiTags('Note ratings')
@ApiBearerAuth()
@UseGuards(JwtGuard)
@Controller('note')
export class NoteRatingController {
  constructor(private readonly ratings: NoteRatingService) {}

  // A rater gets one rating a day; the throttle only caps rejected retries.
  @Post(':id/ratings')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Rate a note (recorded on the root of its collect chain)',
  })
  @ApiOkResponse({ type: NoteRatingResultDto })
  rate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateNoteRatingDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteRatingResultDto> {
    return this.ratings.rate(req.user.userId, id, dto);
  }

  @Get(':id/ratings/summary')
  @ApiOperation({
    summary: "This month's counters and whether the viewer may rate",
  })
  @ApiOkResponse({ type: NoteRatingSummaryDto })
  summary(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithUser,
  ): Promise<NoteRatingSummaryDto> {
    return this.ratings.getSummary(req.user.userId, id);
  }

  @Get(':id/ratings/bad')
  @ApiOperation({
    summary: 'Bad ratings of my source note (reason, text, time; no rater)',
  })
  @ApiOkResponse({ type: NoteBadRatingListDto })
  badRatings(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListNoteBadRatingsQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteBadRatingListDto> {
    return this.ratings.listBadRatings(req.user.userId, id, query);
  }

  @Post('ratings/:ratingId/appeal')
  @UseGuards(UserThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Appeal a bad rating on my note (once each)' })
  @ApiOkResponse({ type: NoteBadRatingDto })
  appeal(
    @Param('ratingId', ParseUUIDPipe) ratingId: string,
    @Body() dto: AppealNoteRatingDto,
    @Req() req: RequestWithUser,
  ): Promise<NoteBadRatingDto> {
    return this.ratings.appeal(req.user.userId, ratingId, dto);
  }
}
