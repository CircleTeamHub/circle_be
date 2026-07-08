import { Injectable, Logger } from '@nestjs/common';
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
  type RegisterPushTokenDto,
  type NotificationRealtimeDto,
} from './notification.dto';
import { NotificationPushService } from './notification-push.service';

const NOTIFICATION_DEDUPE_WINDOW_MS = 60 * 60 * 1000;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    private readonly pushService: NotificationPushService,
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

  /**
   * Fire-and-forget offline push. Dispatched with `void` (never awaited) from
   * the notification-creation path so a slow Expo round-trip can't add latency
   * to the user's request. Fully self-contained: every failure is caught and
   * logged here, so the floating promise can never reject.
   */
  private async sendPushBestEffort(
    userId: string,
    notification: NotificationRealtimeDto,
  ): Promise<void> {
    try {
      await this.pushService.sendNotification(userId, notification);
    } catch (error) {
      this.logger.warn(
        `Push notification failed for ${notification.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async registerPushToken(
    userId: string,
    dto: RegisterPushTokenDto,
  ): Promise<void> {
    await this.prisma.devicePushToken.upsert({
      where: { token: dto.token },
      create: {
        token: dto.token,
        userID: userId,
        platform: dto.platform,
        provider: dto.provider,
        projectId: dto.projectId ?? null,
        appVersion: dto.appVersion ?? null,
      },
      update: {
        userID: userId,
        platform: dto.platform,
        provider: dto.provider,
        projectId: dto.projectId ?? null,
        appVersion: dto.appVersion ?? null,
        disabledAt: null,
      },
    });
  }

  async deletePushToken(userId: string, token: string): Promise<void> {
    await this.prisma.devicePushToken.deleteMany({
      where: {
        userID: userId,
        token,
      },
    });
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
    const dto = mapNotificationRealtimeDto(notification);
    void this.sendPushBestEffort(toUserId, dto);
    return dto;
  }

  private async createNotification(data: {
    toUserID: string;
    fromUserID: string;
    type: NotificationType;
    content?: string;
    fromTraceID?: string;
    fromCirclePostID?: string;
    fromCircleID?: string;
    fromInvitationID?: string;
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
    const dto = mapNotificationRealtimeDto(notification);
    void this.sendPushBestEffort(notificationData.toUserID, dto);
    return dto;
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

    const dto = mapNotificationRealtimeDto(notification);
    void this.sendPushBestEffort(params.toUserId, dto);
    return dto;
  }

  async createCircleInvitationNotification(data: {
    toUserID: string;
    fromUserID: string;
    type:
      | typeof NotificationType.CIRCLE_VERIFICATION_REQUESTED
      | typeof NotificationType.CIRCLE_INVITATION_APPROVED
      | typeof NotificationType.CIRCLE_INVITATION_REJECTED
      | typeof NotificationType.CIRCLE_ADMIN_OVERRIDE_APPROVED;
    fromCircleID: string;
    fromInvitationID: string;
    content?: string;
  }): Promise<NotificationRealtimeDto | null> {
    return this.createNotification({
      toUserID: data.toUserID,
      fromUserID: data.fromUserID,
      type: data.type,
      content: data.content ?? '',
      fromCircleID: data.fromCircleID,
      fromInvitationID: data.fromInvitationID,
    });
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

  async getProfileNotifications(userId: string, page = 1) {
    const take = 20;
    const skip = (Math.max(1, page) - 1) * take;
    const rows = await this.prisma.notification.findMany({
      where: {
        toUserID: userId,
        deleted: false,
        type: { in: [...PROFILE_NOTIFICATION_TYPES] },
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
    const mapped = created
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
    mapped.forEach(
      (item) =>
        void this.sendPushBestEffort(item.targetUserId, item.notification),
    );
    return mapped;
  }
}
