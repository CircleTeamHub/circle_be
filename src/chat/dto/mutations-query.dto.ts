import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MUTATION_PAGE_MAX } from '../chat.constants';

/** GET /chat/messages/mutations 的入参:离线期间发生过的撤回/编辑增量。 */
export class MutationsQueryDto {
  @ApiProperty({
    description:
      '起始时刻(ISO 8601);返回此刻之后被撤回或编辑过的消息。' +
      '客户端用上一次成功同步的服务端时间。',
  })
  @IsISO8601()
  since!: string;

  @ApiPropertyOptional({
    description: `条数上限,默认与最大均为 ${MUTATION_PAGE_MAX}`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MUTATION_PAGE_MAX)
  limit?: number;
}
