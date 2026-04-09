import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsEnum,
  IsHexColor,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class SendFriendRequestDto {
  @ApiProperty({ example: 'uuid-of-target-user' })
  @IsUUID()
  targetId: string;

  @ApiPropertyOptional({ example: "Hey, let's be friends!" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  message?: string;

  @ApiPropertyOptional({
    example: 'met at a conference',
    description: 'Sender-owned pending remark stored on the request',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  remark?: string;

  @ApiPropertyOptional({
    example: ['uuid-of-friend-tag'],
    description: 'Sender-owned friend tag ids to attach to the pending request',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  tagIds?: string[];
}

export class HandleFriendRequestDto {
  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'] })
  @IsEnum(['ACCEPTED', 'REJECTED'])
  decision: 'ACCEPTED' | 'REJECTED';
}

export class BlockUserDto {
  @ApiProperty({ example: 'uuid-of-user-to-block' })
  @IsUUID()
  targetId: string;
}

export class FriendProfileDto {
  @ApiProperty() id: string;
  @ApiProperty() accountId: string;
  @ApiProperty() nickname: string;
  @ApiPropertyOptional() avatarUrl: string | null;
  @ApiPropertyOptional() avatarFrame: string | null;
  @ApiProperty() gender: string;
  @ApiPropertyOptional() lastOnline: Date | null;
  /** When this friendship was accepted */
  @ApiProperty() friendsSince: Date;
}

export class FriendTagDto {
  @ApiProperty() id: string;
  @ApiProperty() ownerID: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional() color: string | null;
}

export class FriendSettingsDto {
  @ApiPropertyOptional() remark: string | null;
  @ApiProperty({ type: [FriendTagDto] }) assignedTags: FriendTagDto[];
  @ApiProperty({ type: [FriendTagDto] }) availableTags: FriendTagDto[];
}

export class FriendRequestDto {
  @ApiProperty() id: string;
  @ApiProperty() state: string;
  @ApiProperty() createdAt: Date;
  @ApiPropertyOptional() message: string | null;
  @ApiProperty() user: {
    id: string;
    accountId: string;
    nickname: string;
    avatarUrl: string | null;
  };
}

export class FriendStatusDto {
  @ApiProperty({
    enum: ['NONE', 'PENDING_SENT', 'PENDING_RECEIVED', 'ACCEPTED', 'BLOCKED'],
  })
  status: 'NONE' | 'PENDING_SENT' | 'PENDING_RECEIVED' | 'ACCEPTED' | 'BLOCKED';
  @ApiPropertyOptional() requestId: string | null;
}

export class FriendActivityCounterpartyDto {
  @ApiProperty() id: string;
  @ApiProperty() accountId: string;
  @ApiProperty() nickname: string;
  @ApiPropertyOptional() avatarUrl: string | null;
}

export class FriendActivityDto {
  @ApiProperty() id: string;
  @ApiProperty({
    enum: [
      'REQUEST_RECEIVED',
      'REQUEST_SENT',
      'REQUEST_ACCEPTED_BY_OTHER',
      'REQUEST_REJECTED_BY_OTHER',
      'REQUEST_ACCEPTED_BY_ME',
      'REQUEST_REJECTED_BY_ME',
      'REQUEST_WITHDRAWN_BY_OTHER',
    ],
  })
  type: string;
  @ApiProperty() requestId: string;
  @ApiProperty() requestState: string;
  @ApiPropertyOptional() messageSnapshot: string | null;
  @ApiPropertyOptional() readAt: Date | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty() counterparty: FriendActivityCounterpartyDto;
}

export class FriendActivityUnreadCountDto {
  @ApiProperty() count: number;
}

export class SetRemarkDto {
  @ApiPropertyOptional({
    example: '高中同学小王',
    description: 'Pass null to clear',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  remark?: string | null;
}

export class CreateFriendTagDto {
  @ApiProperty({ example: '高中同学' })
  @IsString()
  @MaxLength(30)
  name: string;

  @ApiPropertyOptional({
    example: '#FF6B6B',
    description: 'Hex color for UI display',
  })
  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class AssignTagDto {
  @ApiProperty({ example: 'uuid-of-tag' })
  @IsUUID()
  tagId: string;
}
