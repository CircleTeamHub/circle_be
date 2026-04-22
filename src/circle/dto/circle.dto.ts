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

const CIRCLE_CATEGORIES = [
  'LIFE',
  'FOOD',
  'SPORTS',
  'SOCIAL',
  'GAMING',
  'PHOTOGRAPHY',
  'WORK',
  'TRADE',
  'CUSTOM',
] as const;

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
  @IsIn(CIRCLE_CATEGORIES, { each: true })
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

  @ApiPropertyOptional({ default: 500 })
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

// ── Response DTOs ────────────────────────────────────────────────────────────

export class CircleDto {
  id: string;
  name: string;
  description: string;
  avatarUrl: string | null;
  ownerID: string;
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
}
