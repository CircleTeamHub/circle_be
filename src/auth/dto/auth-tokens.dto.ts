import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthTokensDto {
  @ApiProperty({ example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...' })
  accessToken: string;

  @ApiProperty({ example: 'c8c1f46b2b9c...' })
  refreshToken: string;

  @ApiPropertyOptional({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'OpenIM IM token for SDK login. Empty string if OpenIM is not configured.',
  })
  imToken: string;
}
