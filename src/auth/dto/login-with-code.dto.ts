import {
  IsEmail,
  IsIn,
  IsNumberString,
  IsOptional,
  Length,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginWithCodeDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: '123456' })
  @IsNumberString()
  @Length(6, 6)
  code: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsIn([1, 2, 5])
  platform?: 1 | 2 | 5;
}
