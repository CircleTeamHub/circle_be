import { Expose, Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DisplayIconDto } from 'src/icon/dto/icon.dto';
import {
  type FancyNumberStatusSnapshot,
  resolveEffectiveFancyNumber,
} from 'src/fancy-number/fancy-number-status';

export class MembershipNameAppearanceDto {
  @ApiProperty({
    enum: ['default', 'silver', 'gold', 'rainbow', 'exclusive-shimmer'],
  })
  @Expose()
  nameColor: string;

  @ApiPropertyOptional({
    enum: ['silver', 'gold', 'diamond', 'super-lifetime'],
    nullable: true,
  })
  @Expose()
  badge: string | null;
}

export class PublicMembershipAppearanceDto {
  @ApiProperty({ example: 3, minimum: 0, maximum: 4 })
  @Expose()
  effectiveLevel: number;

  @ApiProperty({ enum: ['regular', 'silver', 'gold', 'diamond', 'super'] })
  @Expose()
  key: string;

  @ApiProperty({ type: MembershipNameAppearanceDto })
  @Expose()
  @Type(() => MembershipNameAppearanceDto)
  appearance: MembershipNameAppearanceDto;
}

export class AvatarFrameAppearanceDto {
  @ApiProperty()
  @Expose()
  id: string;

  @ApiProperty()
  @Expose()
  key: string;

  @ApiProperty()
  @Expose()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  @Expose()
  imageUrl: string | null;
}

/**
 * Safe public profile — no PII, no account role/status. Used as-is for the
 * account search (GET /user/search/account) and as the base of the profile and
 * self views. role/status live on SelfUserDto only: on this view they let any
 * signed-in user pick out admin accounts.
 */
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

  @ApiProperty({ type: AvatarFrameAppearanceDto, nullable: true })
  @Expose()
  @Type(() => AvatarFrameAppearanceDto)
  avatarFrameAppearance: AvatarFrameAppearanceDto | null;

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

  @ApiProperty({
    example: 3,
    minimum: 0,
    maximum: 4,
    description: 'Effective public membership level for display.',
  })
  @Expose()
  vipLevel: number;
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

  // 管理台登录门（RequireAdmin / LoginPage）只从 /auth/me 读这两个字段。
  @ApiProperty({ example: 'USER', enum: ['USER', 'ADMIN'] })
  @Expose()
  role: string;

  @ApiProperty({ example: 'ACTIVE' })
  @Expose()
  status: string;

  // 靓号租约到期由 fancy-number 流程惰性回收（每分钟一轮 sweep），回收前列上仍是
  // true。与广场 / 圈子准入同一条判定，只外露结果；租期两列不外露。
  @ApiProperty({
    example: false,
    description: '当前是否持有有效靓号（租约已过期即为 false）',
  })
  @Expose()
  @Transform(({ obj }: { obj: FancyNumberStatusSnapshot }) =>
    resolveEffectiveFancyNumber(obj),
  )
  fancyNumber: boolean;

  @ApiProperty({ example: 100 })
  @Expose()
  creditScore: number;

  @ApiProperty({ example: 12, description: '收到的累计点赞总数' })
  @Expose()
  receivedLikeCount: number;
}

/**
 * Profile detail view for GET /user/:id. `phoneNumber` and `email` are
 * included only after UserService applies the target user's privacy settings
 * (showPhone / showEmail, both opt-in and off by default) — they are nulled
 * for viewers the target has not permitted. Not on PublicUserDto: the account
 * search endpoint must stay contact-free.
 */
export class ProfileUserDto extends PublicUserDto {
  @ApiPropertyOptional({ example: '+8613800138000' })
  @Expose()
  phoneNumber: string | null;

  @ApiPropertyOptional({ example: 'user@example.com', nullable: true })
  @Expose()
  email: string | null;

  @ApiProperty({ example: 12, description: '收到的累计点赞总数' })
  @Expose()
  likeCount: number;
}
