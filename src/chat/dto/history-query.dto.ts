import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { HISTORY_PAGE_MAX } from '../chat.constants';

export class HistoryQueryDto {
  @ApiPropertyOptional({ description: '取该 height 之前的消息(键集分页游标)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  beforeHeight?: number;

  @ApiPropertyOptional({
    description: `单页条数,默认 50,上限 ${HISTORY_PAGE_MAX}`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HISTORY_PAGE_MAX)
  limit?: number;
}
