import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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

  @ApiProperty()
  @IsUUID()
  circleId: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  noteId?: string;

  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  @IsOptional()
  isHorn?: boolean;

  @ApiPropertyOptional({
    description: 'Min VIP level to interact, null = no restriction',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
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
}

export class PlazaFeedQueryDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  circleId?: string;

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

// ── Response DTOs ────────────────────────────────────────────────────────────

export class PlazaPostAuthorDto {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  avatarFrame: string | null;
  accountId: string;
  vipLevel: number;
  fancyNumber: boolean;
  isNewUser: boolean;
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
  isHorn: boolean;
  noteId: string | null;
  restrictions: {
    vipLevel: number | null;
    creditScore: number | null;
    fancyNumber: boolean;
  };
  viewCount: number;
  author: PlazaPostAuthorDto;
  circle: PlazaPostCircleDto;
  canInteract: boolean;
  createdAt: string;
}
