import { Injectable } from '@nestjs/common';
import { NotificationType } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';

const DISCOVER_NOTIFICATION_TYPES = [
  NotificationType.TRACE_COMMENT,
  NotificationType.COMMENT_REPLY,
] as const;

const PROFILE_NOTIFICATION_TYPES = [NotificationType.SYSTEM] as const;

@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
  ) {}

  async getUnreadSummary(userId: string) {
    const [discoverUnread, profileUnread] = await Promise.all([
      this.prisma.notification.count({
        where: {
          toUserID: userId,
          deleted: false,
          read: false,
          type: { in: [...DISCOVER_NOTIFICATION_TYPES] },
        },
      }),
      this.prisma.notification.count({
        where: {
          toUserID: userId,
          deleted: false,
          read: false,
          type: { in: [...PROFILE_NOTIFICATION_TYPES] },
        },
      }),
    ]);

    return {
      discoverUnread,
      profileUnread,
      totalUnread: discoverUnread + profileUnread,
    };
  }

  async markProfileNotificationsRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: {
        toUserID: userId,
        deleted: false,
        read: false,
        type: { in: [...PROFILE_NOTIFICATION_TYPES] },
      },
      data: { read: true },
    });

    await this.realtimeService.broadcastSystemNotificationUnread(userId);

    return result;
  }

  async createSystemNotification(
    toUserId: string,
    fromUserId: string,
    content: string,
  ) {
    if (!toUserId || !fromUserId || toUserId !== fromUserId) {
      return null;
    }

    return this.prisma.notification.create({
      data: {
        toUserID: toUserId,
        fromUserID: fromUserId,
        type: NotificationType.SYSTEM,
        content,
      },
    });
  }

  async createTraceCommentNotifications(params: {
    actorId: string;
    traceId: string;
    commentId: string;
    traceOwnerId: string;
    replyToCommentId?: string | null;
    replyToUserId?: string | null;
    content: string;
  }) {
    const notifications = [];
    const notifiedUserIds = new Set<string>();

    if (
      params.traceOwnerId &&
      params.traceOwnerId !== params.actorId &&
      !notifiedUserIds.has(params.traceOwnerId)
    ) {
      notifiedUserIds.add(params.traceOwnerId);
      notifications.push(
        this.prisma.notification.create({
          data: {
            toUserID: params.traceOwnerId,
            fromUserID: params.actorId,
            type: NotificationType.TRACE_COMMENT,
            content: params.content,
            fromTraceID: params.traceId,
            fromReplyID: params.commentId,
          },
        }),
      );
    }

    if (
      params.replyToUserId &&
      params.replyToUserId !== params.actorId &&
      !notifiedUserIds.has(params.replyToUserId)
    ) {
      notifiedUserIds.add(params.replyToUserId);
      notifications.push(
        this.prisma.notification.create({
          data: {
            toUserID: params.replyToUserId,
            fromUserID: params.actorId,
            type: NotificationType.COMMENT_REPLY,
            content: params.content,
            fromTraceID: params.traceId,
            fromReplyID: params.commentId,
            toReplyID: params.replyToCommentId ?? null,
          },
        }),
      );
    }

    await Promise.all(notifications);
    return [...notifiedUserIds];
  }
}
