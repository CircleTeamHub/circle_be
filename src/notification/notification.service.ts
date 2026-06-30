import { Injectable } from '@nestjs/common';
import { NotificationType } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  DISCOVER_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from './notification.constants';
import {
  mapNotificationRealtimeDto,
  NOTIFICATION_REALTIME_INCLUDE,
  type NotificationRealtimeDto,
} from './notification.dto';

const NOTIFICATION_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
  ) {}

  private isDiscoverNotification(type: NotificationType): boolean {
    return (
      DISCOVER_NOTIFICATION_TYPES as readonly NotificationType[]
    ).includes(type);
  }

  private isProfileNotification(type: NotificationType): boolean {
    return (PROFILE_NOTIFICATION_TYPES as readonly NotificationType[]).includes(
      type,
    );
  }

  private async broadcastUnreadForType(userId: string, type: NotificationType) {
    if (this.isDiscoverNotification(type)) {
      await this.realtimeService.broadcastInteractionUnread(userId);
      return;
    }
    if (this.isProfileNotification(type)) {
      await this.realtimeService.broadcastSystemNotificationUnread(userId);
    }
  }

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

    // Skip the broadcast when no rows changed — saves a redundant unread-count
    // query and avoids waking idle WS clients on no-op calls.
    if (result.count > 0) {
      await this.realtimeService.broadcastSystemNotificationUnread(userId);
    }

    return result;
  }

  async createSystemNotification(
    toUserId: string,
    fromUserId: string,
    content: string,
  ): Promise<NotificationRealtimeDto | null> {
    if (!toUserId || !fromUserId || toUserId !== fromUserId) {
      return null;
    }

    const notification = await this.prisma.notification.create({
      data: {
        toUserID: toUserId,
        fromUserID: fromUserId,
        type: NotificationType.SYSTEM,
        content,
      },
      include: NOTIFICATION_REALTIME_INCLUDE,
    });
    return mapNotificationRealtimeDto(notification);
  }

  private async createNotification(data: {
    toUserID: string;
    fromUserID: string;
    type: NotificationType;
    content?: string;
    fromTraceID?: string;
    fromCirclePostID?: string;
    dedupeWindowMs?: number;
  }): Promise<NotificationRealtimeDto | null> {
    if (
      !data.toUserID ||
      !data.fromUserID ||
      data.toUserID === data.fromUserID
    ) {
      return null;
    }

    const { dedupeWindowMs, ...notificationData } = data;
    if (dedupeWindowMs) {
      const duplicate = await this.prisma.notification.findFirst({
        where: {
          toUserID: notificationData.toUserID,
          fromUserID: notificationData.fromUserID,
          type: notificationData.type,
          deleted: false,
          ...(notificationData.fromTraceID
            ? { fromTraceID: notificationData.fromTraceID }
            : {}),
          ...(notificationData.fromCirclePostID
            ? { fromCirclePostID: notificationData.fromCirclePostID }
            : {}),
          createdAt: { gte: new Date(Date.now() - dedupeWindowMs) },
        },
        select: { id: true },
      });
      if (duplicate) {
        return null;
      }
    }

    const notification = await this.prisma.notification.create({
      data: {
        ...notificationData,
        content: notificationData.content ?? '',
      },
      include: NOTIFICATION_REALTIME_INCLUDE,
    });
    return mapNotificationRealtimeDto(notification);
  }

  async createFriendRequestNotification(params: {
    type:
      | typeof NotificationType.FRIEND_REQUEST_RECEIVED
      | typeof NotificationType.FRIEND_REQUEST_ACCEPTED
      | typeof NotificationType.FRIEND_REQUEST_REJECTED;
    toUserId: string;
    fromUserId: string;
    content?: string | null;
  }): Promise<NotificationRealtimeDto | null> {
    return this.createNotification({
      toUserID: params.toUserId,
      fromUserID: params.fromUserId,
      type: params.type,
      content: params.content ?? '',
    });
  }

  async createTraceLikeNotification(params: {
    actorId: string;
    traceId: string;
    traceOwnerId: string;
  }): Promise<NotificationRealtimeDto | null> {
    return this.createNotification({
      toUserID: params.traceOwnerId,
      fromUserID: params.actorId,
      type: NotificationType.TRACE_LIKE,
      fromTraceID: params.traceId,
      dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS,
    });
  }

  async createCirclePostSignupNotification(params: {
    toUserId: string;
    fromUserId: string;
    postId: string;
  }): Promise<NotificationRealtimeDto | null> {
    return this.createNotification({
      toUserID: params.toUserId,
      fromUserID: params.fromUserId,
      type: NotificationType.CIRCLE_POST_SIGNUP_CREATED,
      fromCirclePostID: params.postId,
      dedupeWindowMs: NOTIFICATION_DEDUPE_WINDOW_MS,
    });
  }

  async createCirclePostAutoEndedNotification(params: {
    toUserId: string;
    postId: string;
  }): Promise<NotificationRealtimeDto | null> {
    if (!params.toUserId || !params.postId) {
      return null;
    }

    const notification = await this.prisma.notification.create({
      data: {
        toUserID: params.toUserId,
        fromUserID: params.toUserId,
        type: NotificationType.CIRCLE_POST_AUTO_ENDED,
        fromCirclePostID: params.postId,
        content: '',
      },
      include: NOTIFICATION_REALTIME_INCLUDE,
    });

    return mapNotificationRealtimeDto(notification);
  }

  async getNotifications(userId: string, page = 1) {
    const take = 20;
    const skip = (Math.max(1, page) - 1) * take;
    const rows = await this.prisma.notification.findMany({
      where: {
        toUserID: userId,
        deleted: false,
        type: { in: [...DISCOVER_NOTIFICATION_TYPES] },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: NOTIFICATION_REALTIME_INCLUDE,
    });
    return rows.map(mapNotificationRealtimeDto);
  }

  async markNotificationRead(userId: string, id: string): Promise<void> {
    const notification = await this.prisma.notification.findFirst({
      where: { id, toUserID: userId, deleted: false },
      select: { type: true, read: true },
    });
    if (!notification) return;

    const result = await this.prisma.notification.updateMany({
      where: { id, toUserID: userId, read: false, deleted: false },
      data: { read: true },
    });
    if (result.count > 0) {
      await this.broadcastUnreadForType(userId, notification.type);
    }
  }

  async markAllNotificationsRead(userId: string): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        toUserID: userId,
        deleted: false,
        read: false,
        type: { in: [...DISCOVER_NOTIFICATION_TYPES] },
      },
      data: { read: true },
    });
    if (result.count > 0) {
      await this.realtimeService.broadcastInteractionUnread(userId);
    }
    return { count: result.count };
  }

  async deleteNotification(userId: string, id: string): Promise<void> {
    const notification = await this.prisma.notification.findFirst({
      where: { id, toUserID: userId, deleted: false },
      select: { type: true, read: true },
    });
    if (!notification) return;

    const result = await this.prisma.notification.updateMany({
      where: { id, toUserID: userId, deleted: false },
      data: { deleted: true },
    });
    if (result.count > 0 && !notification.read) {
      await this.broadcastUnreadForType(userId, notification.type);
    }
  }

  async createTraceCommentNotifications(params: {
    actorId: string;
    traceId: string;
    commentId: string;
    traceOwnerId: string;
    replyToCommentId?: string | null;
    replyToUserId?: string | null;
    content: string;
  }): Promise<
    Array<{ targetUserId: string; notification: NotificationRealtimeDto }>
  > {
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
          include: NOTIFICATION_REALTIME_INCLUDE,
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
          include: NOTIFICATION_REALTIME_INCLUDE,
        }),
      );
    }

    // Atomic: either both notifications land or neither does — a partial
    // failure must not leave one orphaned notification behind.
    const created = await this.prisma.$transaction(notifications);
    return created
      .map((notification) => ({
        targetUserId: notification.toUserID,
        notification: mapNotificationRealtimeDto(notification),
      }))
      .filter(
        (
          item,
        ): item is {
          targetUserId: string;
          notification: NotificationRealtimeDto;
        } => typeof item.targetUserId === 'string',
      );
  }
}
