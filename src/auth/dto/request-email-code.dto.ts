import { IsEmail, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RequestEmailCodeDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'register', enum: ['register', 'login'] })
  @IsIn(['register', 'login'])
  purpose: 'register' | 'login';
}
