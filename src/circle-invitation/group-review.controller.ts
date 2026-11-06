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
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Throttle } from '@nestjs/throttler';
import type { RequestWithUser } from 'src/auth/types';
import { AppAudienceGuard } from 'src/guards/app-audience.guard';
import { JwtGuard } from 'src/guards/jwt.guard';
import { UserThrottlerGuard } from 'src/guards/user-throttler.guard';
import {
  GroupReviewService,
  type GroupReviewAction,
} from './group-review.service';

export class GroupReviewQueryDto {
  @IsOptional() @IsUUID('4') cursor?: string;
  @IsOptional() @IsString() @MaxLength(64) keyword?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) limit?: number;
}
export class GroupReviewActionDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ids!: string[];
  @IsIn(['approve', 'reject', 'blacklist']) action!: GroupReviewAction;
}

@Controller('chat/groups')
@UseGuards(JwtGuard, AppAudienceGuard, UserThrottlerGuard)
export class GroupReviewController {
  constructor(private readonly reviews: GroupReviewService) {}

  @Get(':id/reviews')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  list(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: GroupReviewQueryDto,
  ) {
    return this.reviews.list(req.user.userId, id, query);
  }

  @Post(':id/reviews/actions')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  act(
    @Req() req: RequestWithUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: GroupReviewActionDto,
  ) {
    return this.reviews.act(req.user.userId, id, body.ids, body.action);
  }
}
