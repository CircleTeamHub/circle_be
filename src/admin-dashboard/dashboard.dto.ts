import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';

export enum DashboardRange {
  Today = 'today',
  SevenDays = '7d',
  ThirtyDays = '30d',
}

export class DashboardQueryDto {
  @ApiPropertyOptional({
    enum: DashboardRange,
    default: DashboardRange.Today,
  })
  @IsOptional()
  @IsEnum(DashboardRange)
  range: DashboardRange = DashboardRange.Today;
}
