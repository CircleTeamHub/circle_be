import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
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

  /** 当前配置的内容哈希;写回时必须原样带上,用于乐观并发校验。 */
  @ApiProperty()
  revision: string;
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

  // 全局 ValidationPipe 开着 enableImplicitConversion(src/setup.ts),它会把任意
  // 非空字符串转成 true —— `enabled: "false"` 会被静默当成「启用」,管理员以为停用了
  // 某个客服、它其实还在线上接待。@Transform 读转换前的原值,让 @IsBoolean 能看见
  // 真实类型并拒绝掉。
  @ApiPropertyOptional({ default: true })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.enabled)
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

  // 读到这份配置时的 revision。整表覆盖没有它就是「最后保存的人赢」:开着旧页签的
  // 管理员一保存,另一个人刚存的改动会被整个抹掉,双方都收不到任何提示。
  //
  // 过渡期先做成可选:后端与管理台是分开部署的,一上来就必填会让「新后端 + 旧管理台」
  // 这段窗口里的每一次保存都 400。缺省时退回旧行为(不做并发校验),等管理台版本铺开后
  // 再由后续一个后端版本改成必填。带上它的客户端立刻就受保护。
  @ApiPropertyOptional({ description: 'GET 返回的 revision，原样回传' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  expectedRevision?: string;
}
