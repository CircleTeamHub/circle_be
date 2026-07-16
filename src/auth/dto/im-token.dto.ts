import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Query for GET /auth/im-token.
 *
 * Deliberately carries no user identifier: the token is always minted for the
 * authenticated caller (see AuthController.imToken). `platform` mirrors
 * LoginDto.platform because OpenIM tokens are scoped per platform slot — a
 * re-established session must target the same slot it logged in on.
 */
export class ImTokenQueryDto {
  /** OpenIM platform ID — 1=iOS, 2=Android, 5=Web. See LoginDto.platform. */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsIn([1, 2, 5])
  platform?: 1 | 2 | 5;
}

/**
 * Response for GET /auth/im-token. Uses the same `imToken` field name as
 * AuthTokensDto so the client can reuse its login-response parsing.
 */
export class ImTokenDto {
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description:
      'OpenIM IM token for SDK login, minted for the authenticated caller. Never an empty string — a 503 is returned instead when OpenIM is unavailable or unconfigured.',
  })
  imToken: string;
}
