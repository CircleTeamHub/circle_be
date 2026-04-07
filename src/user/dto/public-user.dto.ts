import { Expose } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

  @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
  @Expose()
  avatarUrl: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/frame.png' })
  @Expose()
  avatarFrame: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/cover.png' })
  @Expose()
  cover: string | null;

  @ApiPropertyOptional({ example: 'user@example.com' })
  @Expose()
  email: string | null;

  @ApiPropertyOptional({ example: '+8613800138000' })
  @Expose()
  phoneNumber: string | null;

  @ApiPropertyOptional({ example: 'wxid_xxx' })
  @Expose()
  wechat: string | null;

  @ApiPropertyOptional({ example: '123456789' })
  @Expose()
  qq: string | null;

  @ApiPropertyOptional({ example: 'Coding every day' })
  @Expose()
  whatsup: string | null;

  @ApiPropertyOptional({ example: 'Full-stack developer' })
  @Expose()
  persona: string | null;

  @ApiPropertyOptional({ example: 'Hey there!' })
  @Expose()
  helloWords: string | null;

  @ApiPropertyOptional({ example: '2000-01-01T00:00:00.000Z' })
  @Expose()
  birthday: Date | null;

  @ApiProperty({ example: 'unset', enum: ['male', 'female', 'other', 'unset'] })
  @Expose()
  gender: string;

  @ApiProperty({ example: 'USER', enum: ['USER', 'ADMIN'] })
  @Expose()
  role: string;

  @ApiProperty({ example: 'ACTIVE' })
  @Expose()
  status: string;

  @ApiPropertyOptional({ example: '2026-04-06T00:00:00.000Z' })
  @Expose()
  lastOnline: Date | null;

  @ApiProperty({ example: '2026-04-02T00:00:00.000Z' })
  @Expose()
  createdAt: Date;

  @ApiProperty({ example: '2026-04-02T00:00:00.000Z' })
  @Expose()
  updatedAt: Date;
}
