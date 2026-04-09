import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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
