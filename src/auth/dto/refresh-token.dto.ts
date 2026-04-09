import { IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

// randomBytes(64).toString('hex') = 128 hex chars
const REFRESH_TOKEN_LENGTH = 128;

export class RefreshTokenDto {
  @ApiProperty({ example: 'c8c1f46b2b9c...' })
  @IsString()
  @IsNotEmpty()
  @Length(REFRESH_TOKEN_LENGTH, REFRESH_TOKEN_LENGTH)
  refreshToken: string;
}
