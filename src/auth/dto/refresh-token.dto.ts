import { IsNotEmpty, IsString, Length } from 'class-validator';
import { ApiProperty, PartialType } from '@nestjs/swagger';

// randomBytes(64).toString('hex') = 128 hex chars
const REFRESH_TOKEN_LENGTH = 128;

export class RefreshTokenDto {
  @ApiProperty({ example: 'c8c1f46b2b9c...' })
  @IsString()
  @IsNotEmpty()
  @Length(REFRESH_TOKEN_LENGTH, REFRESH_TOKEN_LENGTH)
  refreshToken: string;
}

/**
 * POST auth/refresh 与 auth/logout：网页端（X-Web-Session: 1）的 refresh token 在
 * cookie 里，绑定信息走 Authorization 头，正文继续为空。原生 App 必须提交 refresh token。
 */
export class SessionRefreshTokenDto extends PartialType(RefreshTokenDto) {}
