import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class LoginChallengeCodeDto {
  @ApiProperty({
    example: '123456',
    description: '受信任设备批准后显示的 6 位验证码',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}
