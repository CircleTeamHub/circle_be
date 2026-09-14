import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  HISTORY_FILTER_MESSAGE_TYPES,
  HISTORY_PAGE_MAX,
} from '../chat.constants';

/**
 * height 落库是 int4。越界的值会穿过 @IsInt 直达 Prisma,变成一个未映射的引擎
 * 错误 → 500;这个 DTO 同时给 GET /temp-chat/guest/messages 用,一个访客 token
 * 就够触发。与 clear-history.dto.ts 的 targetHeight 同一上界。
 */
const HEIGHT_MAX = 2_147_483_647;

export class HistoryQueryDto {
  @ApiPropertyOptional({ description: '取该 height 之前的消息(键集分页游标)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(HEIGHT_MAX)
  beforeHeight?: number;

  @ApiPropertyOptional({
    description:
      '增量补拉:取该 height 之后的消息,升序返回(与 beforeHeight 互斥;0 = 从头拉)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(HEIGHT_MAX)
  afterHeight?: number;

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
  // 合法类型总共十几种,32 已远超任何真实组合;防超长数组原样灌进 IN 查询。
  @ArrayMaxSize(32)
  @IsIn(HISTORY_FILTER_MESSAGE_TYPES, { each: true })
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

  @ApiPropertyOptional({
    description: '次日本地零点的时区偏移分钟(DST 日期可能与起点不同)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-840)
  @Max(840)
  tzEndOffsetMinutes?: number;
}
