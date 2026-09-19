import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { SYNC_PAGE_MAX } from '../chat.constants';

/** GET /chat/conversations/:id/sync 的入参:会话变更序号流的增量游标。 */
export class SyncQueryDto {
  @ApiProperty({
    description:
      '上一次同步返回的 nextRevision;本机从没同步过这个会话时传 0。' +
      '返回 (afterRevision, 当前最高 revision] 区间里变过的消息的当前状态。',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  afterRevision!: number;

  @ApiPropertyOptional({
    description: `条数上限,默认与最大均为 ${SYNC_PAGE_MAX}`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SYNC_PAGE_MAX)
  limit?: number;
}
