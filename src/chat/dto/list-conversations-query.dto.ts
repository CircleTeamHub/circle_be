import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
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

  /**
   * 键集分页游标。不带 = 旧的活跃度排序（已装机 App 永远不带，行为不变）；
   * 带上 = 按 conversationID 升序翻页：空串从头开始，非空时只返回 id 严格大于它的会话。
   */
  @ApiPropertyOptional({
    type: String,
    description:
      '键集分页游标。不传 = 旧模式（置顶优先、再按末条消息时间倒序，只有 X-Has-More）。' +
      '传了 = 键集模式：按会话 id 升序返回；空串表示从头开始，非空时须为上一页响应头 ' +
      'X-Next-Cursor 给出的会话 id（UUID），只返回 id 严格大于它的会话。' +
      '还有下一页时响应头带 X-Has-More: true 与 X-Next-Cursor。',
    example: '',
  })
  // 会话 id 由 Prisma uuid() 生成，全是小写；游标按文本比较，大写游标不归一化的话
  // 会与小写 id 排到不同位置，翻页时静默跳行。
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsOptional()
  // @IsOptional() 只跳过 null/undefined，不跳过空串；空串是「从头开始」的合法值。
  @ValidateIf((_dto: ListConversationsQueryDto, value: unknown) => value !== '')
  @IsUUID()
  cursor?: string;
}
