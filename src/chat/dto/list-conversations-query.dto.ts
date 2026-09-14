import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import {
  CONVERSATION_LIST_LIMIT_MAX,
  CONVERSATION_LIST_MAX,
} from '../chat.constants';

export class ListConversationsQueryDto {
  @ApiPropertyOptional({
    description: `本页最多返回的会话数（默认 ${CONVERSATION_LIST_MAX}，上限 ${CONVERSATION_LIST_LIMIT_MAX}）。被截断时响应头 X-Has-More: true。`,
    minimum: 1,
    maximum: CONVERSATION_LIST_LIMIT_MAX,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONVERSATION_LIST_LIMIT_MAX)
  limit?: number;
}
