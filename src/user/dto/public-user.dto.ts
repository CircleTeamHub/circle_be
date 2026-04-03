import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export class PublicUserDto {
  @ApiProperty({ example: '7f6dcb5e-0d94-463c-b6b3-165b1aa77845' })
  @Expose()
  id: string;

  @ApiProperty({ example: 'ACC_ABC123' })
  @Expose()
  accountId: string;

  @ApiProperty({ example: 'testuser' })
  @Expose()
  username: string;

  @ApiProperty({ example: 'Test User' })
  @Expose()
  nickname: string;

  @ApiProperty({ example: 'https://example.com/avatar.png', nullable: true })
  @Expose()
  avatarUrl: string | null;

  @ApiProperty({ example: 'ACTIVE' })
  @Expose()
  status: string;

  @ApiProperty({ example: '2026-04-02T00:00:00.000Z' })
  @Expose()
  createdAt: Date;
}
