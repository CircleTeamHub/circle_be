import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { UserStatus } from 'src/generated/prisma';

export class GetUserDto {
  @ApiPropertyOptional({ example: 1, description: 'Current page number' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    example: 10,
    description: 'Items per page (max 100)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    example: 'jimmyddddd',
    description: 'Filter by accountId',
  })
  @IsOptional()
  @IsString()
  accountId?: string;

  @ApiPropertyOptional({
    enum: UserStatus,
    description: 'Filter by account status',
  })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;
}
