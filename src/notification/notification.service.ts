import { Injectable } from '@nestjs/common';
import { NotificationType } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  DISCOVER_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from './notification.constants';

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

  async getNotifications(userId: string, page = 1) {
    const take = 20;
    const skip = (Math.max(1, page) - 1) * take;
    const rows = await this.prisma.notification.findMany({
      where: { toUserID: userId, deleted: false },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        fromUser: { select: { id: true, nickname: true, avatarUrl: true } },
        fromTrace: { select: { id: true, content: true, images: true } },
        fromReply: { select: { id: true, content: true } },
      },
    });
    return rows.map((n) => ({
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
    }));
  }

  async markNotificationRead(userId: string, id: string): Promise<void> {
    const result = await this.prisma.notification.updateMany({
      where: { id, toUserID: userId, read: false, deleted: false },
      data: { read: true },
    });
    if (result.count > 0) {
      await this.realtimeService.broadcastSystemNotificationUnread(userId);
    }
  }

  async markAllNotificationsRead(userId: string): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: { toUserID: userId, deleted: false, read: false },
      data: { read: true },
    });
    if (result.count > 0) {
      await this.realtimeService.broadcastSystemNotificationUnread(userId);
    }
    return { count: result.count };
  }

  async deleteNotification(userId: string, id: string): Promise<void> {
    const result = await this.prisma.notification.updateMany({
      where: { id, toUserID: userId, deleted: false },
      data: { deleted: true },
    });
    if (result.count > 0) {
      await this.realtimeService.broadcastSystemNotificationUnread(userId);
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

    // Atomic: either both notifications land or neither does — a partial
    // failure must not leave one orphaned notification behind.
    await this.prisma.$transaction(notifications);
    return [...notifiedUserIds];
  }
}
