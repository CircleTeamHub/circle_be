import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'jimmyddddd' })
  @IsString()
  @IsNotEmpty()
  @Length(4, 32)
  accountId: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @IsNotEmpty()
  @Length(6, 64)
  password: string;

  @ApiPropertyOptional({ example: 'Jimmy' })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  nickname?: string;

  @ApiPropertyOptional({ example: 'user@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+8613800138000' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;
}
