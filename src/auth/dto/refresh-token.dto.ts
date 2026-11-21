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
 * cookie 里，请求体为空；其余请求仍必须带，由控制器把关。管理台路由继续用上面的必填版。
 */
export class SessionRefreshTokenDto extends PartialType(RefreshTokenDto) {}
