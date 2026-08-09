import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  isUUID,
} from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import {
  AdminGroupOperationType,
  CircleAdminState,
} from 'src/generated/prisma';
import { MAX_PAGE } from 'src/common/pagination';

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !isUUID(value, '4')) {
    throw new BadRequestException('Idempotency-Key 必须是 UUID v4');
  }
  return value;
}

export class AdminCommunityListQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsString()
  @MaxLength(100)
  search?: string;
}

export class AdminCircleListQueryDto extends AdminCommunityListQueryDto {
  @ApiPropertyOptional({ enum: CircleAdminState })
  @IsOptional()
  @IsEnum(CircleAdminState)
  status?: CircleAdminState;
}

export class AdminConfirmedActionDto {
  @ApiProperty({ minLength: 2, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  reason: string;

  @ApiProperty({ maxLength: 128 })
  @Transform(({ value }: { value: unknown }) => trim(value))
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  confirmation: string;
}

export class AdminGroupOperationDto extends AdminConfirmedActionDto {
  @ApiProperty({ enum: AdminGroupOperationType })
  @IsEnum(AdminGroupOperationType)
  type: AdminGroupOperationType;
}
