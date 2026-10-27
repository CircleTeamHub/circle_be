import { Prisma, NotificationType } from 'src/generated/prisma';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  NOTIFICATION_DOMAINS,
  type NotificationDomain,
} from './notification.constants';
import { Transform, Type } from 'class-transformer';
import { MAX_PAGE } from 'src/common/pagination';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  IsInt,
  Min,
  Max,
  Validate,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
  type ValidationArguments,
} from 'class-validator';

export class NotificationPageQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PAGE, default: 1 })
  @IsOptional()
  page = 1;

  // Cursor mode is opt-in so existing clients can keep consuming the array
  // response from the page-based endpoint while new clients avoid deep OFFSET.
  @ApiPropertyOptional({ maxLength: 256 })
  @IsString()
  @MaxLength(256)
  @IsOptional()
  cursor?: string;

  // A first cursor page has no token yet. This explicit switch keeps the
  // legacy array response unchanged while letting new clients request the
  // cursor envelope before they have a cursor to send back.
  @ApiPropertyOptional({ type: Boolean, default: false })
  @Transform(({ obj }: { obj: Record<string, unknown> }) => {
    const value = obj.cursorMode;
    if (value === undefined) return undefined;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return value;
  })
  @IsBoolean()
  @IsOptional()
  cursorMode?: boolean;
}

export class NotificationListQueryDto extends NotificationPageQueryDto {
  // 省略 domain = 全域（老客户端）。moments = 朋友圈铃铛，circle = 圈子铃铛。
  @ApiPropertyOptional({ enum: NOTIFICATION_DOMAINS })
  @IsIn(NOTIFICATION_DOMAINS)
  @IsOptional()
  domain?: NotificationDomain;
}

export class NotificationDomainQueryDto {
  @ApiPropertyOptional({ enum: NOTIFICATION_DOMAINS })
  @IsIn(NOTIFICATION_DOMAINS)
  @IsOptional()
  domain?: NotificationDomain;
}

export class EditSystemAnnouncementDto {
  @ApiProperty({ minLength: 1, maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title: string;

  @ApiProperty({ minLength: 1, maxLength: 5000 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content: string;
}

export class AnnouncementScrollingDto {
  @ApiProperty()
  @IsBoolean()
  scrolling: boolean;
}

export class PublishSystemAnnouncementDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  scrolling?: boolean;

  // Optional for older clients and historical announcements; new publishing UI requires it.
  @ApiPropertyOptional({ minLength: 1, maxLength: 100 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  title?: string;

  @ApiProperty({ minLength: 1, maxLength: 5000 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  content: string;
}

export class PublishSystemAnnouncementResponseDto {
  @ApiProperty() createdCount: number;
}

export const PUSH_TOKEN_PLATFORMS = ['ios', 'android', 'web'] as const;
export const PUSH_TOKEN_PROVIDERS = ['expo', 'jpush'] as const;

export type PushTokenPlatform = (typeof PUSH_TOKEN_PLATFORMS)[number];
export type PushTokenProvider = (typeof PUSH_TOKEN_PROVIDERS)[number];

const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[^\s\]]+\]$/;

@ValidatorConstraint({ name: 'pushTokenShape', async: false })
class PushTokenShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments) {
    if (typeof value !== 'string') return true;
    const provider = (args.object as { provider?: PushTokenProvider }).provider;
    return provider === 'expo'
      ? EXPO_PUSH_TOKEN_PATTERN.test(value)
      : /^\S+$/.test(value);
  }

  defaultMessage(args: ValidationArguments) {
    const provider = (args.object as { provider?: PushTokenProvider }).provider;
    return provider === 'expo'
      ? 'token must be an Expo push token (ExponentPushToken[...])'
      : 'token must not contain whitespace';
  }
}

export class RegisterPushTokenDto {
  // Expo token 使用稳定的 Expo 格式；JPush token 是 SDK 分配的
  // Registration ID，格式可能随版本和平台变化，只要求无空白。
  @ApiProperty({
    maxLength: 512,
    example: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx] or 190e35e4f...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  @Validate(PushTokenShapeConstraint)
  token: string;

  @ApiProperty({ enum: PUSH_TOKEN_PLATFORMS })
  @IsIn(PUSH_TOKEN_PLATFORMS)
  platform: PushTokenPlatform;

  @ApiProperty({ enum: PUSH_TOKEN_PROVIDERS })
  @IsIn(PUSH_TOKEN_PROVIDERS)
  provider: PushTokenProvider;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  projectId?: string;

  @ApiPropertyOptional({ maxLength: 128 })
  @IsString()
  @IsOptional()
  @MaxLength(128)
  appVersion?: string;

  @ApiPropertyOptional({ minLength: 32, maxLength: 256 })
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  @IsOptional()
  revocationSecret?: string;
}

export class DeletePushTokenDto {
  @ApiProperty({ maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;
}

export class RevokePushTokenDto {
  @ApiProperty({ minLength: 1, maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(512)
  token: string;

  @ApiProperty({ minLength: 32, maxLength: 256 })
  @IsString()
  @MinLength(32)
  @MaxLength(256)
  revocationSecret: string;
}

export type NotificationRealtimeDto = {
  title?: string | null;
  id: string;
  type: NotificationType;
  content: string;
  read: boolean;
  createdAt: string;
  fromUser: { id: string; nickname: string; avatarUrl: string | null } | null;
  fromTrace: { id: string; excerpt: string; firstImage: string | null } | null;
  fromReply: { id: string; content: string } | null;
  fromCircle: { id: string; name: string } | null;
  fromCirclePost: {
    id: string;
    excerpt: string;
    firstImage: string | null;
  } | null;
  fromInvitation: { id: string; status: string } | null;
  fromGroupAdmission?: { id: string; status: string } | null;
  requestId?: string | null;
};

export type NotificationCursor = {
  createdAt: string;
  id: string;
};

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeNotificationCursor(
  value: string,
): NotificationCursor | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString('utf8'),
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const cursor = parsed as Record<string, unknown>;
    if (
      typeof cursor.id !== 'string' ||
      cursor.id.length === 0 ||
      cursor.id.length > 128 ||
      typeof cursor.createdAt !== 'string' ||
      Number.isNaN(Date.parse(cursor.createdAt))
    ) {
      return null;
    }
    return {
      id: cursor.id,
      createdAt: new Date(cursor.createdAt).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * 组装实时 DTO / 推送文案要读的 Notification 本表列（含全部外键）。
 *
 * 关系不再用 include 一次拉 9 个：Prisma 7 对每个 include 各发一条查询、用
 * Promise.all 并发（非事务时一条占一个池连接），外键全空的关系也照发。现在先取
 * 本表列，再由 notification-realtime.loader 按外键只查用得到的关系、逐条顺序查。
 */
export const NOTIFICATION_REALTIME_BASE_SELECT = {
  id: true,
  type: true,
  content: true,
  read: true,
  createdAt: true,
  toUserID: true,
  fromUserID: true,
  fromTraceID: true,
  fromReplyID: true,
  fromCircleID: true,
  fromCirclePostID: true,
  fromInvitationID: true,
  fromGroupAdmissionID: true,
  fromFriendRequestID: true,
  systemAnnouncementID: true,
} as const satisfies Prisma.NotificationSelect;

export type NotificationRealtimeBaseRow = Prisma.NotificationGetPayload<{
  select: typeof NOTIFICATION_REALTIME_BASE_SELECT;
}>;

/** 与原来 9 路 include 各关系 select 出来的形状一致。 */
export type NotificationRealtimeRelations = {
  systemAnnouncement: { title: string | null } | null;
  fromUser: { id: string; nickname: string; avatarUrl: string | null } | null;
  fromTrace: { id: string; content: string; images: string[] } | null;
  fromReply: { id: string; content: string } | null;
  fromCircle: { id: string; name: string } | null;
  fromCirclePost: { id: string; content: string; images: string[] } | null;
  fromInvitation: { id: string; status: string } | null;
  fromGroupAdmission: { id: string; status: string } | null;
};

export type NotificationRealtimeRow = NotificationRealtimeBaseRow &
  NotificationRealtimeRelations;

/**
 * composeMessage 实际读到的字段。正文非空时它不会往下读回复 / 帖子 / 动态的摘要，
 * 所以这几个字段可以缺省 —— 推送路径因此不必为每条通知都去拉 5000 字的正文。
 * NotificationRealtimeDto 结构上是它的超集，可以直接传进去。
 */
export type NotificationPushSource = {
  id: string;
  type: NotificationType;
  content: string;
  title?: string | null;
  fromUser: { id: string; nickname: string } | null;
  fromTrace: { id: string; excerpt?: string } | null;
  fromReply: { id: string; content?: string } | null;
  fromCirclePost: { id: string; excerpt?: string } | null;
  fromInvitation: { id: string } | null;
  fromGroupAdmission?: { id: string } | null;
  requestId?: string | null;
};

/** 动态 / 帖子在通知里只露这么长的摘要。 */
export const NOTIFICATION_EXCERPT_LENGTH = 60;

export function mapNotificationRealtimeDto(
  n: NotificationRealtimeRow,
): NotificationRealtimeDto {
  return {
    id: n.id,
    type: n.type,
    content: n.content,
    title: n.systemAnnouncement?.title ?? null,
    read: n.read,
    createdAt: n.createdAt.toISOString(),
    fromUser: n.fromUser
      ? {
          id: n.fromUser.id,
          nickname: n.fromUser.nickname,
          avatarUrl: n.fromUser.avatarUrl,
        }
      : null,
    fromTrace: n.fromTrace
      ? {
          id: n.fromTrace.id,
          excerpt: n.fromTrace.content.slice(0, NOTIFICATION_EXCERPT_LENGTH),
          firstImage: n.fromTrace.images[0] ?? null,
        }
      : null,
    fromReply: n.fromReply
      ? { id: n.fromReply.id, content: n.fromReply.content }
      : null,
    fromCircle: n.fromCircle
      ? { id: n.fromCircle.id, name: n.fromCircle.name }
      : null,
    fromCirclePost: n.fromCirclePost
      ? {
          id: n.fromCirclePost.id,
          excerpt: n.fromCirclePost.content.slice(
            0,
            NOTIFICATION_EXCERPT_LENGTH,
          ),
          firstImage: n.fromCirclePost.images[0] ?? null,
        }
      : null,
    fromInvitation: n.fromInvitation
      ? { id: n.fromInvitation.id, status: n.fromInvitation.status }
      : null,
    ...(n.fromGroupAdmission
      ? {
          fromGroupAdmission: {
            id: n.fromGroupAdmission.id,
            status: n.fromGroupAdmission.status,
          },
        }
      : {}),
    // 外键 ON DELETE SET NULL：外键非空时 Friend 行一定在，不必为一个 id 再查一次表。
    requestId: n.fromFriendRequestID ?? null,
  };
}

/**
 * 圈子通知偏好里唯一需要服务端执行的一档：离线推送。
 * 横幅 / 声音 / 红点全是客户端展示，留在本地即可，不进这个接口。
 */
export class UpdateCirclePushPreferenceDto {
  @ApiProperty({
    example: true,
    description: 'APP 离线时是否接收圈子推送（关闭后服务端不再投递圈子推送）',
  })
  // 全局 ValidationPipe 开着 enableImplicitConversion（src/setup.ts），它会把任意
  // 非空字符串转成 true —— `circleOfflinePushEnabled: "false"` 会被静默当成「开着」，
  // 用户以为关掉了离线提醒、其实照收不误，而这个开关唯一的意义就是关掉它。
  // @Transform 读转换前的原值，让 @IsBoolean 看得见真实类型并拒掉。
  // 做法与 support.dto.ts 的 enabled / circle.dto.ts 的 memberCanInvite 一致。
  @Transform(
    ({ obj }: { obj: Record<string, unknown> }) => obj.circleOfflinePushEnabled,
  )
  @IsBoolean()
  circleOfflinePushEnabled: boolean;
}
