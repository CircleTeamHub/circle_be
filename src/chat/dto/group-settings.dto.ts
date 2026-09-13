import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export const GROUP_NOTICE_MAX_LENGTH = 500;

export class SetGroupMuteAllDto {
  @ApiProperty({ description: 'true=开启全员禁言;false=解除' })
  // 全局 ValidationPipe 开着 enableImplicitConversion，会把字符串 "false"
  // 转成 true。读取转换前的原值，让 IsBoolean 拒绝非 JSON boolean。
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.enabled)
  @IsBoolean()
  enabled!: boolean;
}

export class TransferGroupOwnerDto {
  @ApiProperty({ description: '新群主 userId(必须是在座成员,不能是自己)' })
  @IsUUID('4')
  userId!: string;
}

export class SetGroupNoticeDto {
  @ApiProperty({
    description: `群公告;空串 = 清空`,
    maxLength: GROUP_NOTICE_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(GROUP_NOTICE_MAX_LENGTH)
  notice!: string;
}

export class SetGroupAvatarDto {
  @ApiProperty({ description: '群头像 URL(必须来自本应用存储)' })
  @IsString()
  @MaxLength(2048)
  avatarUrl!: string;
}

export const GROUP_ALIAS_MAX_LENGTH = 30;

export class SetMyGroupRemarkDto {
  @ApiProperty({
    description: '我给这个群起的备注(只有我看得见);空串 = 清除,回落群名',
    maxLength: GROUP_ALIAS_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(GROUP_ALIAS_MAX_LENGTH)
  remark!: string;
}

export class SetMyGroupAliasDto {
  @ApiProperty({
    description: '本人在该群的昵称;空串 = 清除,回落账号昵称',
    maxLength: GROUP_ALIAS_MAX_LENGTH,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(GROUP_ALIAS_MAX_LENGTH)
  alias!: string;
}

export class UpdateGroupPoliciesDto {
  @ApiPropertyOptional({ description: '普通成员能否拉人进群' })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.memberCanInvite)
  @IsOptional()
  @IsBoolean()
  memberCanInvite?: boolean;

  @ApiPropertyOptional({ description: '群二维码能否入群' })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj.qrJoinEnabled)
  @IsOptional()
  @IsBoolean()
  qrJoinEnabled?: boolean;

  @ApiPropertyOptional({ description: '普通成员能否看到群成员名单' })
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) => obj.membersCanViewRoster,
  )
  @IsOptional()
  @IsBoolean()
  membersCanViewRoster?: boolean;

  @ApiPropertyOptional({ description: '普通成员能否从群里打开其他成员资料' })
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) => obj.membersCanViewProfiles,
  )
  @IsOptional()
  @IsBoolean()
  membersCanViewProfiles?: boolean;

  @ApiPropertyOptional({ description: '普通成员能否通过群加其他成员为好友' })
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) => obj.membersCanAddFriends,
  )
  @IsOptional()
  @IsBoolean()
  membersCanAddFriends?: boolean;
}
