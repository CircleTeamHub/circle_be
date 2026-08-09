import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CLIENT_MESSAGE_TYPES, HISTORY_PAGE_MAX } from '../chat.constants';

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

  @ApiPropertyOptional({
    description: '消息类型白名单,逗号分隔(如 image 或 text,quote)',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string'
      ? value.split(',').filter((v: string) => v.length > 0)
      : value,
  )
  @IsIn(CLIENT_MESSAGE_TYPES, { each: true })
  types?: string[];

  @ApiPropertyOptional({ description: '文本关键词(content.text 包含匹配)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  keyword?: string;

  @ApiPropertyOptional({ description: "按天过滤:'YYYY-MM-DD'(客户端时区)" })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @ApiPropertyOptional({
    description: '客户端时区偏移分钟(getTimezoneOffset 语义)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-840)
  @Max(840)
  tzOffsetMinutes?: number;
}
