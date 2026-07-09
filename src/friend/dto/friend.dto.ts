import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsHexColor,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
// Type-only: the Prisma v7 client exports enums as types, so referencing
// `FriendPermission.CHAT_ONLY` as a runtime value throws. Validation/Swagger use
// the local const below instead (same approach as FRIEND_REPORT_CATEGORIES).
import type { FriendPermission } from 'src/generated/prisma';

/** Upper bound on description photo notes attached to one friendship. */
export const FRIEND_DESCRIPTION_PHOTO_LIMIT = 9;

/** Runtime values for the FriendPermission enum, for validators and Swagger. */
export const FRIEND_PERMISSIONS = ['FULL', 'CHAT_ONLY'] as const;

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
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({
    example: 'Met at the 2026 design conference, leads the UI team.',
    description: 'Sender-owned private description note, promoted on accept',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Sender-owned description photo urls/keys, promoted on accept (max 9)',
    example: ['https://cdn.example.com/friends/abc.jpg'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(FRIEND_DESCRIPTION_PHOTO_LIMIT)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  // These render in the sender's own contact card; reject angle brackets so a
  // stored value can never smuggle HTML/script markup into a client webview.
  @Matches(/^[^<>]+$/, {
    each: true,
    message: 'photo entries contain invalid characters',
  })
  photos?: string[];

  @ApiPropertyOptional({
    enum: FRIEND_PERMISSIONS,
    example: 'CHAT_ONLY',
    description:
      'Moments access the sender grants the target once accepted (default FULL)',
  })
  @IsOptional()
  @IsEnum(FRIEND_PERMISSIONS)
  permission?: FriendPermission;
}

export class SendFriendRequestMessageDto {
  @ApiProperty({
    example: 'Hi, we met at the design conference last week.',
    description: 'Plain-text message appended to the pending request thread',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  content: string;
}

export class BlockUserDto {
  @ApiProperty({ example: 'uuid-of-user-to-block' })
  @IsUUID()
  targetId: string;
}

export const FRIEND_REPORT_CATEGORIES = [
  'harassment',
  'spam',
  'impersonation',
  'fraud',
  'other',
] as const;

export class ReportFriendDto {
  @ApiProperty({
    enum: FRIEND_REPORT_CATEGORIES,
    example: 'harassment',
  })
  @IsEnum(FRIEND_REPORT_CATEGORIES)
  category: (typeof FRIEND_REPORT_CATEGORIES)[number];

  @ApiProperty({
    example: 'Repeated abusive language in chat.',
    maxLength: 500,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Optional evidence references such as object keys or URLs.',
    example: ['reports/chat-12345.png'],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  // Evidence is surfaced to moderators; reject angle brackets so a report
  // cannot smuggle HTML/script markup into an admin console.
  @Matches(/^[^<>]+$/, {
    each: true,
    message: 'evidence entries contain invalid characters',
  })
  evidence?: string[];
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
  @ApiPropertyOptional() description: string | null;
  @ApiProperty({ type: [String] }) photos: string[];
  @ApiProperty({ enum: FRIEND_PERMISSIONS }) permission: FriendPermission;
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
  @IsNotEmpty()
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
