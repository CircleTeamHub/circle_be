import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const TRACE_VISIBILITY = ['FRIENDS_ONLY', 'PRIVATE'] as const;

// ── Request DTOs ─────────────────────────────────────────────────────────────

export class CreateTraceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(9)
  @IsOptional()
  images?: string[];

  @ApiPropertyOptional({ enum: TRACE_VISIBILITY, default: 'FRIENDS_ONLY' })
  @IsEnum(TRACE_VISIBILITY)
  @IsOptional()
  visibility?: 'FRIENDS_ONLY' | 'PRIVATE';
}

export class CreateTraceCommentDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  content: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  replyToId?: string;
}

export class TraceFeedQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: '只看某个用户的朋友圈' })
  @IsUUID()
  @IsOptional()
  authorId?: string;

  @ApiPropertyOptional({
    description:
      'Keyset 游标（不透明字符串，来自上一页的 nextCursor）。传入时按游标翻页，' +
      '忽略 page，且不再执行 count()——深翻页时开销恒定。',
  })
  @IsString()
  @IsOptional()
  @MaxLength(200)
  cursor?: string;
}

export class NewCountQueryDto {
  @ApiProperty()
  @IsISO8601()
  since: string;
}

// ── Response DTOs ────────────────────────────────────────────────────────────

export class TraceAuthorDto {
  id: string;
  nickname: string;
  avatarUrl: string | null;
}

export class TraceCommentDto {
  id: string;
  content: string;
  user: { id: string; nickname: string };
  replyTo: { id: string; nickname: string } | null;
  createdAt: string;
}

export class TraceDto {
  id: string;
  content: string;
  images: string[];
  visibility: string;
  author: TraceAuthorDto;
  likeCount: number;
  commentCount: number;
  isLikedByMe: boolean;
  likedFriends: { id: string; nickname: string }[];
  comments: TraceCommentDto[];
  createdAt: string;
}
