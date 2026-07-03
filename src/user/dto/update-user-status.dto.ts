import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { UserStatus } from 'src/generated/prisma';

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus, example: UserStatus.BANNED })
  @IsEnum(UserStatus)
  status: UserStatus;

  @ApiProperty({
    required: false,
    maxLength: 500,
    description: 'Optional admin note explaining the status change',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
