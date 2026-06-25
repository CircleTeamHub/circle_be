import { Type } from 'class-transformer';
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
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const MY_CIRCLE_TABS = ['joined', 'created', 'applied'] as const;

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

  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  @IsOptional()
  joinVipRestriction?: number;

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

  @ApiPropertyOptional({ description: 'Max members; omit for no limit.' })
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(5000)
  @IsOptional()
  maxMembers?: number;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  memberCanPost?: boolean;

  @ApiPropertyOptional({
    default: true,
    description:
      'Public circles auto-admit on join; private circles require the invitation flow.',
  })
  @IsBoolean()
  @IsOptional()
  isPublic?: boolean;
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
  cities: string[];
  isPublic: boolean;
  categories: string[];
  rules: string;
  tags: string[];
  joinVipRestriction: number | null;
  joinCreditRestriction: number | null;
  joinFancyRestriction: boolean;
  maxMembers: number;
  memberCanPost: boolean;
  groupID: string | null;
  memberCount: number;
  postCount: number;
  createdAt: string;
}

export class CircleDetailDto extends CircleDto {
  myRole: 'OWNER' | 'ADMIN' | 'MEMBER' | null;
  myStatus: 'ACTIVE' | 'PENDING' | 'REJECTED' | null;
  availableIconAssets?: Array<{
    id: string;
    name: string;
    imageUrl: string | null;
  }>;
}
