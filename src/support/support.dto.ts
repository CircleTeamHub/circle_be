import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

export const SUPPORT_AGENT_CATEGORIES = [
  'recharge',
  'issue',
  'dispute',
  'account',
  'membership',
] as const;

export type SupportAgentCategory = (typeof SUPPORT_AGENT_CATEGORIES)[number];

/** App 渲染一行客服所需的全部信息 —— 避免客户端拿到 userID 后再逐个查用户。 */
export class SupportAgentViewDto {
  @ApiProperty()
  userID: string;

  @ApiProperty()
  nickname: string;

  @ApiPropertyOptional({ nullable: true })
  avatarUrl: string | null;

  @ApiProperty()
  vipLevel: number;
}

export class SupportConfigDto {
  @ApiProperty({
    description: '五类客服各自的列表，按 sortOrder 排序；未配置的类是空数组。',
  })
  agents: Record<SupportAgentCategory, SupportAgentViewDto[]>;
}

/** 管理台读取用：包含停用行，否则管理台无法把它们改回启用。 */
export class AdminSupportAgentDto extends SupportAgentViewDto {
  @ApiProperty({ enum: SUPPORT_AGENT_CATEGORIES })
  category: SupportAgentCategory;

  @ApiProperty()
  sortOrder: number;

  @ApiProperty()
  enabled: boolean;
}

export class AdminSupportAgentsDto {
  @ApiProperty({ type: [AdminSupportAgentDto] })
  agents: AdminSupportAgentDto[];
}

export class SupportAgentInputDto {
  @ApiProperty({ enum: SUPPORT_AGENT_CATEGORIES })
  @IsIn(SUPPORT_AGENT_CATEGORIES)
  category: SupportAgentCategory;

  @ApiProperty()
  @IsUUID()
  userID: string;

  @ApiProperty()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortOrder: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ReplaceSupportAgentsDto {
  @ApiProperty({
    type: [SupportAgentInputDto],
    description:
      '整表覆盖：未出现在这里的行会被删除。停用请传 enabled=false 而不是省略，' +
      '这样顺序与创建时间得以保留。',
  })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => SupportAgentInputDto)
  agents: SupportAgentInputDto[];
}
