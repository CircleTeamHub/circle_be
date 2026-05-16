import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ConversationGroupDto {
  @ApiProperty()
  @Expose()
  id: string;

  @ApiProperty()
  @Expose()
  name: string;

  @ApiProperty()
  @Expose()
  sortOrder: number;

  @ApiProperty({
    description:
      'Whether this group renders as a filter tab on the messages list. Owners can toggle visibility without deleting the group.',
  })
  @Expose()
  pinnedToTabs: boolean;

  @ApiProperty({ type: [String], description: 'OpenIM conversationIDs that belong to this group.' })
  @Expose()
  conversationIDs: string[];

  @ApiProperty()
  @Expose()
  createdAt: string;

  @ApiProperty()
  @Expose()
  updatedAt: string;
}

export class CreateConversationGroupDto {
  @ApiProperty({ minLength: 1, maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  name: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  pinnedToTabs?: boolean;

  @ApiPropertyOptional({
    description: 'Initial sortOrder; defaults to 0. Reserved for v2 drag-reorder.',
  })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateConversationGroupDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 32 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinnedToTabs?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class SetConversationGroupMembersDto {
  @ApiProperty({
    type: [String],
    description:
      'Authoritative list of conversationIDs this group should contain. Server replaces existing membership with exactly this set.',
  })
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  @Type(() => String)
  conversationIDs: string[];
}
