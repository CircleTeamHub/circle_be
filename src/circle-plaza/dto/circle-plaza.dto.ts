import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
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
import { DisplayIconDto } from 'src/icon/dto/icon.dto';
import {
  AvatarFrameAppearanceDto,
  PublicMembershipAppearanceDto,
} from 'src/user/dto/public-user.dto';

// ── Request DTOs ─────────────────────────────────────────────────────────────

export class CreatePlazaPostDto {
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

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(5)
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ description: 'Legacy single circle (= circleIds[0])' })
  @IsUUID()
  @IsOptional()
  circleId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: '圈子多选（去重，至少 1 个，最多 50）',
  })
  @IsArray()
  @IsUUID('all', { each: true })
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsOptional()
  circleIds?: string[];

  @ApiPropertyOptional({ description: 'Legacy single city (= cities[0])' })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({
    type: [String],
    description: '城市多选（去重，最多 50）',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(50)
  @IsOptional()
  cities?: string[];

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  noteId?: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isHorn?: boolean;

  @ApiPropertyOptional({
    description: 'Post lifetime in hours. Min 24h, max 168h.',
    default: 24,
  })
  @Type(() => Number)
  @IsInt()
  @Min(24)
  @Max(168)
  @IsOptional()
  expiresInHours?: number;

  @ApiPropertyOptional({
    description: 'Min VIP level to interact, null = no restriction',
    minimum: 0,
    maximum: 4,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  vipRestriction?: number;

  @ApiPropertyOptional({
    description: 'Min credit score to interact, null = no restriction',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  creditRestriction?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  fancyRestriction?: boolean;

  @ApiPropertyOptional({
    description: 'Min VIP level to sign up, null = no restriction',
    minimum: 0,
    maximum: 4,
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  signupVipRestriction?: number;

  @ApiPropertyOptional({
    description: 'Min credit score to sign up, null = no restriction',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  signupCreditRestriction?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  signupFancyRestriction?: boolean;
}

export class RecognizePostCollaboratorsDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 3 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  recipientIds: string[];
}

export class CollaborationRecognitionResultDto {
  count: number;
  recognizedUserIds: string[];
}

export class PlazaFeedQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  circleId?: string;

  @ApiPropertyOptional({ description: 'Comma-separated circle IDs' })
  @IsString()
  @IsOptional()
  circleIds?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(100)
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ description: 'Comma-separated city names (legacy)' })
  @IsString()
  @MaxLength(4096)
  @IsOptional()
  cities?: string;

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

export class PlazaFeedSearchDto {
  @ApiPropertyOptional()
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  circleId?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  @IsOptional()
  circleIds?: string[];

  @ApiProperty({ type: [String], maxItems: 1000 })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @ArrayMaxSize(1000)
  cities: string[];

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

  @ApiPropertyOptional({ description: 'Keyset cursor from the previous page' })
  @IsString()
  @MaxLength(200)
  @IsOptional()
  cursor?: string;
}

// ── Response DTOs ────────────────────────────────────────────────────────────

export class PlazaPostAuthorDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  nickname: string;

  @ApiProperty({ type: String, nullable: true })
  avatarUrl: string | null;

  @ApiProperty({ type: String, nullable: true })
  avatarFrame: string | null;

  @ApiProperty({ type: AvatarFrameAppearanceDto, nullable: true })
  @Type(() => AvatarFrameAppearanceDto)
  avatarFrameAppearance: AvatarFrameAppearanceDto | null;

  @ApiProperty()
  accountId: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '有效会员等级（名字特效渲染用，按到期算）；0 = 非会员',
  })
  vipLevel: number | null;

  @ApiProperty({ type: PublicMembershipAppearanceDto })
  @Type(() => PublicMembershipAppearanceDto)
  membership: PublicMembershipAppearanceDto;

  @ApiProperty({ type: [DisplayIconDto] })
  displayIcons: DisplayIconDto[];
}

export class PlazaPostCircleDto {
  id: string;
  name: string;
}

export class PlazaPostDto {
  id: string;
  content: string;
  images: string[];
  tags: string[];
  city: string | null;
  cities: string[];
  isHorn: boolean;
  noteId: string | null;
  restrictions: {
    vipLevel: number | null;
    creditScore: number | null;
    fancyNumber: boolean;
  };
  viewCount: number;
  signupCount: number;
  signedByMe: boolean;
  signupRestrictions: {
    vipLevel: number | null;
    creditScore: number | null;
    fancyNumber: boolean;
  };
  canSignup: boolean;

  @ApiProperty({ type: PlazaPostAuthorDto })
  author: PlazaPostAuthorDto;
  circle: PlazaPostCircleDto;
  circles: PlazaPostCircleDto[];
  canInteract: boolean;
  createdAt: string;
  expiresAt: string;
}

export class MyCirclePostDto {
  id: string;
  circleId: string;
  excerpt: string;
  firstImage: string | null;
  signupCount: number;
  unreadSignupCount: number;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export class PostSignupItemDto {
  userId: string;
  imUserId: string;
  nickname: string;
  avatarUrl: string | null;
  accountId: string;
  signedAt: string;
  seen: boolean;
  displayIcons: DisplayIconDto[];
  recognized: boolean;
}

export class ReportCirclePostDto {
  @ApiPropertyOptional({
    description: 'Optional free-text reason for the report',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// GET /circle-plaza/feed 与 POST /circle-plaza/feed/search 的分页信封响应。之前 feed/search
// 的 @ApiOkResponse 谎报成裸 PlazaPostDto[]，生成的移动端客户端会按错误的顶层结构反序列化。
export class PlazaFeedResponseDto {
  @ApiProperty({ type: PlazaPostDto, isArray: true })
  items: PlazaPostDto[];

  @ApiProperty({
    type: Number,
    nullable: true,
    description: '总数；游标翻页时为 null',
  })
  total: number | null;

  @ApiProperty()
  page: number;

  @ApiProperty()
  limit: number;

  @ApiProperty()
  hasMore: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '下一页 keyset 游标；无更多时为 null',
  })
  nextCursor: string | null;
}
