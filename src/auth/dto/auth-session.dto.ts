import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthSessionDto {
  @ApiProperty({ example: 'session-uuid' })
  id: string;

  @ApiPropertyOptional({ example: 'MacBook Pro' })
  deviceName: string | null;

  @ApiPropertyOptional({ example: '127.0.0.1' })
  ip: string | null;

  @ApiPropertyOptional({ example: 'PostmanRuntime/7.44.1' })
  userAgent: string | null;

  @ApiProperty({ example: '2026-04-03T01:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-04-03T01:05:00.000Z' })
  lastUsedAt: Date;

  @ApiProperty({ example: '2026-04-10T01:00:00.000Z' })
  expiredAt: Date;
}
