import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { Gender } from 'src/generated/prisma';

const URL_VALIDATION_OPTIONS = {
  require_protocol: true,
  require_tld: false,
} as const;

export class UpdateUserDto {
  @ApiPropertyOptional({ example: 'My Nickname' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  nickname?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
  @IsOptional()
  @IsUrl(URL_VALIDATION_OPTIONS)
  avatarUrl?: string;

  @ApiPropertyOptional({ example: 'https://example.com/frame.png' })
  @IsOptional()
  @IsUrl(URL_VALIDATION_OPTIONS)
  avatarFrame?: string;

  @ApiPropertyOptional({ example: 'https://example.com/cover.png' })
  @IsOptional()
  @IsUrl(URL_VALIDATION_OPTIONS)
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

  @ApiPropertyOptional({ example: 'wxid_xxx' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  wechat?: string;

  @ApiPropertyOptional({ example: '123456789' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  qq?: string;

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

  @ApiPropertyOptional({ example: '2000-01-01' })
  @IsOptional()
  @IsDateString()
  birthday?: string;

  @ApiPropertyOptional({ enum: Gender, example: Gender.unset })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;
}
