import { ApiProperty } from '@nestjs/swagger';
import { Transform, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { USER_ID_OR_ALIAS_PATTERN } from 'src/user/user-id-alias';

/** 独立群聊建群上限：一次最多拉 100 人（后续邀请同上限）。 */
const GROUP_INVITE_BATCH_MAX = 100;

const MEMBER_ID_MESSAGE =
  'each value in memberIds must be a user id (UUID or 32-hex alias)';

/**
 * 去掉字符串两端留白;JSON null 归一成 undefined —— 旧契约里 name 是
 * `string | null`,不归一的话 `name?: string` 这个声明在运行时就是谎话。
 */
const trimString = ({ value }: TransformFnParams): unknown => {
  if (typeof value === 'string') return value.trim();
  return value === null ? undefined : value;
};

const trimEach = ({ value }: TransformFnParams): unknown =>
  Array.isArray(value)
    ? value.map((id: unknown) => (typeof id === 'string' ? id.trim() : id))
    : value;

export class CreateGroupConversationDto {
  @ApiProperty({
    description:
      '群名(必填)。空名/缺省由服务端以 CHAT_GROUP_NAME_REQUIRED 拒绝,而不是在 DTO 层打回。',
    maxLength: 30,
  })
  @Transform(trimString)
  // 故意不加 @IsNotEmpty:ValidationPipe 打回的 400 不带 errorCode,客户端只能
  // 显示通用文案。空名/缺省要放行到 ChatService,由它抛 CHAT_GROUP_NAME_REQUIRED。
  @IsOptional()
  @IsString()
  @MaxLength(30)
  name?: string;

  @ApiProperty({
    description: '初始成员 userId 列表(不含建群人;必须是好友)',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(GROUP_INVITE_BATCH_MAX)
  @ArrayUnique()
  // 旧客户端缓存里的成员 id 可能是去连字符的 32-hex 别名:这里按形态放行,
  // ChatService 查好友表/用户表之前会归一成 UUID。
  @Transform(trimEach)
  @IsString({ each: true })
  @Matches(USER_ID_OR_ALIAS_PATTERN, { each: true, message: MEMBER_ID_MESSAGE })
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
  @ArrayUnique()
  @Transform(trimEach)
  @IsString({ each: true })
  @Matches(USER_ID_OR_ALIAS_PATTERN, { each: true, message: MEMBER_ID_MESSAGE })
  memberIds!: string[];
}

export class RenameGroupConversationDto {
  @ApiProperty({ description: '新群名', minLength: 1, maxLength: 30 })
  @Transform(trimString)
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  name!: string;
}
