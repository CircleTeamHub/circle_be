import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsTimeZone, Max, Min } from 'class-validator';

export class MessageDaysQueryDto {
  @ApiProperty({ description: '年份(如 2026)' })
  @Type(() => Number)
  @IsInt()
  @Min(2020)
  @Max(2100)
  year!: number;

  @ApiProperty({ description: '月份(0-based,与 JS Date 一致)' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(11)
  month!: number;

  @ApiPropertyOptional({
    description: '客户端时区偏移分钟(getTimezoneOffset 语义)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-840)
  @Max(840)
  tzOffsetMinutes?: number;

  @ApiPropertyOptional({
    description:
      'IANA timezone used for DST-aware month bounds and day grouping',
    example: 'America/Los_Angeles',
  })
  @IsOptional()
  @IsTimeZone()
  timeZone?: string;
}
