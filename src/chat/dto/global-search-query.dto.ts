import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { HISTORY_PAGE_MAX } from '../chat.constants';

export class GlobalSearchQueryDto {
  @ApiProperty({ description: '关键词(跨本人全部会话搜文本消息)' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  keyword!: string;

  @ApiPropertyOptional({
    description: `条数上限,默认 50,最大 ${HISTORY_PAGE_MAX}`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HISTORY_PAGE_MAX)
  limit?: number;
}
