import {
  IsEmail,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '123456' })
  @IsNumberString()
  @Length(6, 6)
  code: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @Length(6, 64)
  password: string;

  @ApiProperty({ example: 'Jimmy' })
  @IsString()
  @Length(1, 50)
  nickname: string;

  /** OpenIM platform ID — see LoginDto.platform. */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsIn([1, 2, 5])
  platform?: 1 | 2 | 5;
}
