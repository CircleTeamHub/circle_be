import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class AvatarFrameAdminInventoryQueryDto {
  @ApiPropertyOptional({
    description: 'Opaque cursor returned by the previous grant-history page.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 50;
}

export class CreateAvatarFrameGrantDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  frameId: string;

  @ApiPropertyOptional({
    format: 'date-time',
    nullable: true,
    description: 'Future expiration timestamp; null or omitted is permanent.',
  })
  @IsOptional()
  @ValidateIf(
    (dto: CreateAvatarFrameGrantDto) =>
      dto.expiresAt !== undefined && dto.expiresAt !== null,
  )
  @IsISO8601({ strict: true })
  expiresAt?: string | null;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  idempotencyKey: string;
}

export class RevokeAvatarFrameGrantDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
