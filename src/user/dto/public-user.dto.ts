import { Expose, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DisplayIconDto } from 'src/icon/dto/icon.dto';

/** Safe public profile — no PII. Used for GET /user/:id viewed by other users. */
export class PublicUserDto {
  @ApiProperty({ example: '7f6dcb5e-0d94-463c-b6b3-165b1aa77845' })
  @Expose()
  id: string;

  @ApiProperty({ example: 'jimmyddddd' })
  @Expose()
  accountId: string;

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

  @ApiPropertyOptional({ example: '杭州' })
  @Expose()
  city: string | null;

  @ApiPropertyOptional({ example: '上海' })
  @Expose()
  region: string | null;

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

  @ApiProperty({ type: [DisplayIconDto] })
  @Expose()
  @Type(() => DisplayIconDto)
  displayIcons: DisplayIconDto[];
}

/**
 * Full self-view — includes PII (email, phoneNumber).
 * Used for GET /auth/me and profile update responses seen by the owner.
 */
export class SelfUserDto extends PublicUserDto {
  @ApiProperty({ example: 'abc123' })
  @Expose()
  inviteCode: string;

  @ApiPropertyOptional({ example: 'user@example.com' })
  @Expose()
  email: string | null;

  @ApiPropertyOptional({ example: '+8613800138000' })
  @Expose()
  phoneNumber: string | null;

  @ApiProperty({ example: 3 })
  @Expose()
  vipLevel: number;

  @ApiProperty({ example: 100 })
  @Expose()
  creditScore: number;
}

/**
 * Profile detail view for GET /user/:id. `phoneNumber` is included only after
 * UserService applies the target user's privacy setting.
 */
export class ProfileUserDto extends PublicUserDto {
  @ApiPropertyOptional({ example: '+8613800138000' })
  @Expose()
  phoneNumber: string | null;

  @ApiProperty({ example: 12, description: '收到的累计点赞总数' })
  @Expose()
  likeCount: number;

  @ApiProperty({
    example: false,
    description: '当前登录用户今天是否已为其点赞（看自己时恒为 false）',
  })
  @Expose()
  likedByMeToday: boolean;
}
