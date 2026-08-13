import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MAX_PAGE } from 'src/common/pagination';

const MY_CIRCLE_TABS = ['joined', 'created', 'applied'] as const;
const URL_VALIDATION_OPTIONS = {
  require_protocol: true,
  require_tld: false,
} as const;

// ── Request DTOs ─────────────────────────────────────────────────────────────

export class CreateCircleDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(20)
  name: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  // Free-form categories: the 8 preset keys (lowercase, from the client i18n
  // map) plus arbitrary user-entered custom labels. No fixed allowlist — just
  // bound the count and per-item length so the payload stays sane.
  @MaxLength(20, { each: true })
  @ArrayUnique()
  @ArrayMaxSize(5)
  categories: string[];

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  avatarUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(10)
  @MaxLength(50, { each: true })
  @IsOptional()
  cities?: string[];

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  rules?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(3)
  @MaxLength(30, { each: true })
  @IsOptional()
  tags?: string[];

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  joinVipRestriction?: number | null;

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  joinCreditRestriction?: number;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  joinFancyRestriction?: boolean;

  @ApiPropertyOptional({
    description: 'Max members; omit to use membership capacity.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(3000)
  @IsOptional()
  maxMembers?: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  memberCanPost?: boolean;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10,
    description:
      'Verifier votes required to admit an applicant; 1 = no verification. Snapshotted per invitation.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  @IsOptional()
  requiredVerifierCount?: number;
}

/**
 * PATCH /circle/:id 的字段面 = FE 编辑页实际发送的 11 个字段 + 两个招新策略开关。
 *
 * 三个布尔字段都带 @Transform 读原值:全局 ValidationPipe 开着
 * enableImplicitConversion,它会把任意非空字符串转成 true —— `memberCanInvite:
 * "false"` 会被静默当成「开着」,圈主以为关掉了成员邀请,其实没关。做法与
 * support.dto.ts 里的 enabled 一致。
 *
 * 刻意不含 maxMembers:容量走会员配额/扩容流程,不归这条通用编辑路由管。
 * description 允许空串 —— 自研栈下「群公告即圈子简介」,清空公告是合法操作,
 * 不能复用 create 的 MinLength(10)。
 */
export class UpdateCircleDto {
  @ApiPropertyOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(20)
  @ValidateIf((_object, value) => value !== undefined)
  name?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  @ArrayUnique()
  @ArrayMaxSize(5)
  @ValidateIf((_object, value) => value !== undefined)
  categories?: string[];

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @ValidateIf((_object, value) => value !== undefined)
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(500)
  @ValidateIf((_object, value) => value !== undefined)
  avatarUrl?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(10)
  @MaxLength(50, { each: true })
  @ValidateIf((_object, value) => value !== undefined)
  cities?: string[];

  @ApiPropertyOptional()
  @IsString()
  @ValidateIf((_object, value) => value !== undefined)
  @MaxLength(1000)
  rules?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @ArrayMaxSize(3)
  @MaxLength(30, { each: true })
  @ValidateIf((_object, value) => value !== undefined)
  tags?: string[];

  @ApiPropertyOptional({ nullable: true, minimum: 0, maximum: 4 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(4)
  @IsOptional()
  joinVipRestriction?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  joinCreditRestriction?: number | null;

  @ApiPropertyOptional()
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) => obj.joinFancyRestriction,
  )
  @IsBoolean()
  @ValidateIf((_object, value) => value !== undefined)
  joinFancyRestriction?: boolean;

  @ApiPropertyOptional()
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.memberCanPost)
  @IsBoolean()
  @ValidateIf((_object, value) => value !== undefined)
  memberCanPost?: boolean;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 10,
    description:
      'Verifier votes required to admit an applicant; snapshotted per invitation.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  @ValidateIf((_object, value) => value !== undefined)
  requiredVerifierCount?: number;

  @ApiPropertyOptional({
    description: 'false = only OWNER/ADMIN may invite new members.',
  })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.memberCanInvite)
  @IsBoolean()
  @ValidateIf((_object, value) => value !== undefined)
  memberCanInvite?: boolean;
}

export class ListCirclesQueryDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  city?: string;

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
}

export class MyCirclesQueryDto {
  @ApiProperty({ enum: MY_CIRCLE_TABS })
  @IsString()
  @IsIn(MY_CIRCLE_TABS)
  tab: 'joined' | 'created' | 'applied';

  @ApiPropertyOptional({ description: 'Last circle id from the previous page' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({
    maximum: 100,
    description:
      'Page size; defaults to 50 when cursor is provided and 100 otherwise',
  })
  @Type(() => Number)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class SetCircleCoverDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @IsUrl(URL_VALIDATION_OPTIONS)
  @MaxLength(500)
  cover: string;
}

export class SetCircleAvatarDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @IsUrl(URL_VALIDATION_OPTIONS)
  @MaxLength(500)
  avatarUrl: string;
}

export {
  UploadCircleIconDto,
  SelectCircleIconDto,
} from 'src/icon/dto/icon.dto';

// ── Response DTOs ────────────────────────────────────────────────────────────

export class CircleDto {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  ownerID: string;
  currentIconAssetID: string | null;
  currentIconUrl: string | null;
  cover: string | null;
  cities: string[];
  categories: string[];
  rules: string;
  tags: string[];
  joinVipRestriction: number | null;
  joinCreditRestriction: number | null;
  joinFancyRestriction: boolean;
  maxMembers: number;
  memberCanPost: boolean;
  requiredVerifierCount: number;
  memberCanInvite: boolean;
  groupID: string | null;
  memberCount: number;
  postCount: number;
  createdAt: string;
}

export type CircleRole = 'OWNER' | 'ADMIN' | 'MEMBER';

/**
 * GET /circle/my 的返回项。比 CircleDto 多带一个 myRole —— 调用方（「我的圈子」面板）
 * 要靠它区分「我管理的」圈子。角色本来就在 circleMember 行上，顺手返回即可；不返回的话
 * 客户端只能对每个圈子再打一次 GET /circle/:id 把它捞回来（N+1）。
 */
export class MyCircleDto extends CircleDto {
  myRole: CircleRole | null;
}

export class CircleDetailDto extends CircleDto {
  myRole: CircleRole | null;
  myStatus: 'ACTIVE' | 'PENDING' | 'REJECTED' | null;
  availableIconAssets?: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
  }>;
}
