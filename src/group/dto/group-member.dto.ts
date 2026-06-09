import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class InviteGroupMembersDto {
  @ApiProperty({
    type: [String],
    description: 'User IDs to add to the group.',
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(128, { each: true })
  @Type(() => String)
  userIDs: string[];
}

export class GroupMemberSyncResultDto {
  @ApiProperty({
    description:
      'True when this backend handled the group operation; false means the group is a raw OpenIM group and the client should use the SDK.',
  })
  @IsBoolean()
  handled: boolean;
}
