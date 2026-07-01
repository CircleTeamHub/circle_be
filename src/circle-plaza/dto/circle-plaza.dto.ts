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
import { DisplayIconDto } from 'src/icon/dto/icon.dto';

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

  @ApiPropertyOptional({
    description: 'Min VIP level to sign up, null = no restriction',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
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

export class PlazaFeedQueryDto {
  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  circleId?: string;

  @ApiPropertyOptional({ description: 'Comma-separated circle IDs' })
  @IsString()
  @IsOptional()
  circleIds?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ description: 'Comma-separated city names' })
  @IsString()
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
}

// ── Response DTOs ────────────────────────────────────────────────────────────

export class PlazaPostAuthorDto {
  id: string;
  nickname: string;
  avatarUrl: string | null;
  avatarFrame: string | null;
  accountId: string;
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
  author: PlazaPostAuthorDto;
  circle: PlazaPostCircleDto;
  canInteract: boolean;
  createdAt: string;
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
}
