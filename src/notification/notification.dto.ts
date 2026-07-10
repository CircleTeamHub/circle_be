import { Prisma, NotificationType } from 'src/generated/prisma';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export class NotificationPageQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  @ApiPropertyOptional({ minimum: 1, maximum: 10_000, default: 1 })
  @IsOptional()
  page = 1;
}

export const PUSH_TOKEN_PLATFORMS = ['ios', 'android', 'web'] as const;
export const PUSH_TOKEN_PROVIDERS = ['expo'] as const;

export type PushTokenPlatform = (typeof PUSH_TOKEN_PLATFORMS)[number];
export type PushTokenProvider = (typeof PUSH_TOKEN_PROVIDERS)[number];

export class RegisterPushTokenDto {
  @ApiProperty({ maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
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
}

export class DeletePushTokenDto {
  @ApiProperty({ maxLength: 512 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;
}

export type NotificationRealtimeDto = {
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
  requestId?: string | null;
};

export const NOTIFICATION_REALTIME_INCLUDE = {
  fromUser: { select: { id: true, nickname: true, avatarUrl: true } },
  fromTrace: { select: { id: true, content: true, images: true } },
  fromReply: { select: { id: true, content: true } },
  fromCircle: { select: { id: true, name: true } },
  fromCirclePost: { select: { id: true, content: true, images: true } },
  fromInvitation: { select: { id: true, status: true } },
  fromFriendRequest: { select: { id: true } },
} as const;

export type NotificationRealtimeRow = Prisma.NotificationGetPayload<{
  include: typeof NOTIFICATION_REALTIME_INCLUDE;
}>;

export function mapNotificationRealtimeDto(
  n: NotificationRealtimeRow,
): NotificationRealtimeDto {
  return {
    id: n.id,
    type: n.type,
    content: n.content,
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
          excerpt: n.fromTrace.content.slice(0, 60),
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
          excerpt: n.fromCirclePost.content.slice(0, 60),
          firstImage: n.fromCirclePost.images[0] ?? null,
        }
      : null,
    fromInvitation: n.fromInvitation
      ? { id: n.fromInvitation.id, status: n.fromInvitation.status }
      : null,
    requestId: n.fromFriendRequest?.id ?? null,
  };
}
