import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsIn,
  IsNumber,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AvatarFrameAppearanceDto } from 'src/user/dto/public-user.dto';
import { MAX_PAGE } from 'src/common/pagination';
import { ImageMediaVariantDto } from 'src/media/image-media.dto';
import { USER_ID_OR_ALIAS_PATTERN } from 'src/user/user-id-alias';

const TRACE_VISIBILITY = ['FRIENDS_ONLY', 'PRIVATE'] as const;

export class TraceAttachmentInputDto {
  @ApiProperty({ enum: ['image', 'video'] })
  @IsIn(['image', 'video'])
  type: 'image' | 'video';

  @ApiProperty()
  @IsString()
  @MaxLength(500)
  @Matches(/^posts\/[\w-]+\/[\w-]+\.[A-Za-z0-9]+$/)
  key: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^posts\/[\w-]+\/[\w-]+\.[A-Za-z0-9]+$/)
  posterKey?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @ApiPropertyOptional({ description: 'Video duration in seconds' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  duration?: number;
}

export class TraceAttachmentDto extends TraceAttachmentInputDto {
  @ApiProperty() url: string;
  @ApiPropertyOptional() posterUrl?: string;
}

// ── Request DTOs ─────────────────────────────────────────────────────────────

export class CreateTraceDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content: string;

  // 与评论图片同一口径：单个 URL ≤ 500（存储签发的远短于此）；APP 每张图单独
  // presign、key 带 randomUUID，不会发重复 URL，重复只可能来自构造的请求。
  @ApiPropertyOptional({ type: [String], maxItems: 9, uniqueItems: true })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  @ArrayMaxSize(9)
  @ArrayUnique()
  @IsOptional()
  images?: string[];

  @ApiPropertyOptional({ type: [TraceAttachmentInputDto], maxItems: 9 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(9)
  @ArrayUnique((item: TraceAttachmentInputDto) => item?.key)
  @ValidateNested({ each: true })
  @Type(() => TraceAttachmentInputDto)
  attachments?: TraceAttachmentInputDto[];

  @ApiPropertyOptional({ enum: TRACE_VISIBILITY, default: 'FRIENDS_ONLY' })
  @IsEnum(TRACE_VISIBILITY)
  @IsOptional()
  visibility?: 'FRIENDS_ONLY' | 'PRIVATE';
}

export class CreateTraceCommentDto {
  // 图片评论允许纯图无文字；「文字/图片至少有一样」在 service 层校验。
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  content?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(3)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  images?: string[];

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  replyToId?: string;

  @ApiPropertyOptional({ type: [String], maxItems: 20, uniqueItems: true })
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  @IsOptional()
  mentionedUserIds?: string[];
}

// PUT /trace/:id/like：把赞设成指定状态（已是该状态就什么都不做），重放安全。
export class SetTraceLikeDto {
  @ApiProperty()
  @IsBoolean()
  liked: boolean;
}

export class TraceFeedQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
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
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  // Keep legacy UUID-shaped ids and the documented 32-hex alias compatible,
  // while rejecting arbitrary strings before they reach the visibility query.
  @Matches(USER_ID_OR_ALIAS_PATTERN)
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
  @ApiProperty()
  id: string;

  @ApiProperty()
  nickname: string;

  @ApiProperty({ type: String, nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ type: AvatarFrameAppearanceDto, nullable: true })
  @Type(() => AvatarFrameAppearanceDto)
  avatarFrameAppearance: AvatarFrameAppearanceDto | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '会员等级（名字特效渲染用）；null / 0 = 非会员',
  })
  vipLevel: number | null;
}

export class TraceCommentDto {
  id: string;
  content: string;
  images: string[];
  @ApiPropertyOptional({ type: [ImageMediaVariantDto] })
  media?: ImageMediaVariantDto[];
  user: { id: string; nickname: string };
  replyTo: { id: string; nickname: string } | null;
  ignoredMentionCount = 0;
  createdAt: string;
}

export class TraceDto {
  id: string;
  content: string;
  images: string[];
  @ApiPropertyOptional({ type: [TraceAttachmentDto] })
  attachments?: TraceAttachmentDto[];
  @ApiPropertyOptional({ type: [ImageMediaVariantDto] })
  media?: ImageMediaVariantDto[];
  visibility: string;

  @ApiProperty({ type: TraceAuthorDto })
  author: TraceAuthorDto;
  likeCount: number;
  commentCount: number;
  isLikedByMe: boolean;
  likedFriends: { id: string; nickname: string }[];
  comments: TraceCommentDto[];
  createdAt: string;
}
