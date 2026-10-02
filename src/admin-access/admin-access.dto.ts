import { Type, Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AdminConsoleRole } from 'src/generated/prisma';

export class AdminPageQuery {
  @Type(() => Number) @IsInt() @Min(1) @Max(500) page = 1;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) limit = 20;
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  search?: string;
}

export class UpdateAdminAccessDto {
  @IsEnum(AdminConsoleRole) role: AdminConsoleRole;
  @IsInt() @Min(0) version: number;
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Length(2, 500)
  reason: string;
}
