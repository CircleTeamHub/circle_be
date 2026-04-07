import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { UserStatus } from 'src/generated/prisma';

export class UpdateUserStatusDto {
  @ApiProperty({ enum: UserStatus, example: UserStatus.BANNED })
  @IsEnum(UserStatus)
  status: UserStatus;
}
