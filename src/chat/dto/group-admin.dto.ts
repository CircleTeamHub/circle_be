import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import {
  GROUP_EVENTS_PAGE_MAX,
  SILENCE_DURATION_MAX_SEC,
  SILENCE_DURATION_MIN_SEC,
} from '../chat-group-roles';

export const GROUP_MEMBER_ROLE_INPUTS = ['ADMIN', 'MEMBER'] as const;
export type GroupMemberRoleInput = (typeof GROUP_MEMBER_ROLE_INPUTS)[number];

export class SetGroupMemberRoleDto {
  @ApiProperty({
    description: '目标角色(群主不可指派:群主转让不走这里)',
    enum: GROUP_MEMBER_ROLE_INPUTS,
  })
  @IsIn(GROUP_MEMBER_ROLE_INPUTS)
  role!: GroupMemberRoleInput;
}

export class SilenceGroupMemberDto {
  @ApiPropertyOptional({
    description: `禁言秒数(${SILENCE_DURATION_MIN_SEC}–${SILENCE_DURATION_MAX_SEC});显式传 null = 直到解除。字段缺省视为无效,不默认永久。`,
    nullable: true,
  })
  @ValidateIf((dto: SilenceGroupMemberDto) => dto.durationSec !== null)
  @IsInt()
  @Min(SILENCE_DURATION_MIN_SEC)
  @Max(SILENCE_DURATION_MAX_SEC)
  durationSec!: number | null;
}

export class GroupEventsQueryDto {
  @ApiPropertyOptional({ description: '上一页返回的 nextCursor(不透明)' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({
    description: `单页条数,默认 50,上限 ${GROUP_EVENTS_PAGE_MAX}`,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GROUP_EVENTS_PAGE_MAX)
  limit?: number;
}
