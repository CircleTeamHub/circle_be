import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

/** 独立群聊建群上限：一次最多拉 100 人（后续邀请同上限）。 */
const GROUP_INVITE_BATCH_MAX = 100;

export class CreateGroupConversationDto {
  @ApiPropertyOptional({
    description: '群名(可选;空=客户端按成员昵称兜底)',
    maxLength: 30,
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(30)
  @IsOptional()
  name?: string;

  @ApiProperty({
    description: '初始成员 userId 列表(不含建群人;必须是好友)',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(GROUP_INVITE_BATCH_MAX)
  @IsUUID('4', { each: true })
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
  @IsUUID('4', { each: true })
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
