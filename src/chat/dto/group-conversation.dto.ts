import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** 独立群聊建群上限：一次最多拉 100 人（后续邀请同上限）。 */
const GROUP_INVITE_BATCH_MAX = 100;

export class CreateGroupConversationDto {
  @ApiProperty({
    description: '群名',
    maxLength: 30,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  // 缺失或空白群名要由 ChatService 转成稳定的 CHAT_GROUP_NAME_REQUIRED，
  // 这样客户端能显示明确提示；其余格式仍在 DTO 层拦截。
  @ValidateIf((_object, value) => value !== undefined && value !== null)
  @IsString()
  @MaxLength(30)
  name!: string;

  @ApiProperty({
    description: '初始成员 userId 列表(不含建群人;必须是好友)',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(GROUP_INVITE_BATCH_MAX)
  // 用户 ID 曾允许由 OpenIM/历史账号体系生成，不保证是 UUID；真正的成员
  // 授权由 ChatService 依据好友关系与用户表完成，不能在 DTO 阶段误杀合法好友。
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((id) => (typeof id === 'string' ? id.trim() : id))
      : value,
  )
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(191, { each: true })
  memberIds!: string[];
}

export class InviteGroupMembersDto {
  @ApiProperty({
    description: '要拉进群的 userId 列表(必须是邀请人的好友)',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(GROUP_INVITE_BATCH_MAX)
  @Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((id) => (typeof id === 'string' ? id.trim() : id))
      : value,
  )
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(191, { each: true })
  memberIds!: string[];
}

export class RenameGroupConversationDto {
  @ApiProperty({ description: '新群名', minLength: 1, maxLength: 30 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name!: string;
}
