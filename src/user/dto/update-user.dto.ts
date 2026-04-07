import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { Gender } from 'src/generated/prisma';

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'My Nickname' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @ApiPropertyOptional({ example: 'https://example.com/cover.png' })
  @IsOptional()
  @IsUrl()
  cover?: string;

  @ApiPropertyOptional({ example: 'user@example.com' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '+8613800138000' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phoneNumber?: string;

  @ApiPropertyOptional({ example: 'Coding every day' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  whatsup?: string;

  @ApiPropertyOptional({ example: 'Full-stack developer' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  persona?: string;

  @ApiPropertyOptional({ example: 'Hey there!' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  helloWords?: string;

  @ApiPropertyOptional({ enum: Gender, example: Gender.unset })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;
}
