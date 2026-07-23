import {
  IsEmail,
  IsIn,
  IsNumberString,
  IsOptional,
  IsString,
  Length,
  Matches,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ACCOUNT_ID_PATTERN,
  ACCOUNT_ID_RULE_MESSAGE,
} from 'src/utils/account-id';

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
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @Length(1, 50)
  nickname: string;

  @ApiPropertyOptional({ example: 'abc123' })
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const normalized = value.trim().toLowerCase();
    return normalized || undefined;
  })
  @IsOptional()
  @IsString()
  @Matches(ACCOUNT_ID_PATTERN, { message: ACCOUNT_ID_RULE_MESSAGE })
  inviteCode?: string;

  /** OpenIM platform ID — see LoginDto.platform. */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsIn([1, 2, 5])
  platform?: 1 | 2 | 5;
}
