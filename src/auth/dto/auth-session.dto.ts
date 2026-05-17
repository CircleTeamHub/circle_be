import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AuthSessionDto {
  @ApiProperty({ example: 'session-uuid' })
  @Expose()
  id: string;

  @ApiPropertyOptional({ example: 'MacBook Pro' })
  @Expose()
  deviceName: string | null;

  @ApiPropertyOptional({ example: '127.0.0.1' })
  @Expose()
  ip: string | null;

  @ApiPropertyOptional({ example: 'PostmanRuntime/7.44.1' })
  @Expose()
  userAgent: string | null;

  @ApiProperty({ example: '2026-04-03T01:00:00.000Z' })
  @Expose()
  createdAt: Date;

  @ApiProperty({ example: '2026-04-03T01:05:00.000Z' })
  @Expose()
  lastUsedAt: Date;

  @ApiProperty({ example: '2026-04-10T01:00:00.000Z' })
  @Expose()
  expiredAt: Date;
}
