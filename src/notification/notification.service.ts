import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { NotificationType, Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  DISCOVER_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from './notification.constants';
import {
  mapNotificationRealtimeDto,
  NOTIFICATION_REALTIME_INCLUDE,
  type NotificationRealtimeRow,
  type RegisterPushTokenDto,
  type NotificationRealtimeDto,
  type RevokePushTokenDto,
} from './notification.dto';
import { NotificationPushService } from './notification-push.service';

const NOTIFICATION_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
// #98 显式决定：保持 20 而不是原计划的 10。多设备（手机+平板+重装残留）在
// 20 内都装得下，超限按 lastSeen 逐出最旧的；收紧到 10 只会更快逐出仍然
// 活跃的次要设备，没有对应的安全收益（token 本身不可伪造投递身份）。
const MAX_PUSH_TOKENS_PER_USER = 20;

@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    // Kept optional for compatibility with direct service consumers; delivery
    // itself is handled by the durable push outbox processor.
    private readonly pushService?: NotificationPushService,
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

  private async createNotificationWithPush<T extends NotificationRealtimeRow>(
    operation: (tx: any) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const notification = await operation(tx);
      await tx.notificationPushOutbox.create({
        data: { notificationID: notification.id },
      });
      return notification;
    });
  }

  async registerPushToken(
    userId: string,
    dto: RegisterPushTokenDto,
  ): Promise<void> {
    const revocationSecretHash = dto.revocationSecret
      ? this.hashRevocationSecret(dto.revocationSecret)
      : undefined;
    await this.prisma.devicePushToken.upsert({
      where: { token: dto.token },
      create: {
        token: dto.token,
        userID: userId,
        platform: dto.platform,
        provider: dto.provider,
        projectId: dto.projectId ?? null,
        appVersion: dto.appVersion ?? null,
        ...(revocationSecretHash ? { revocationSecretHash } : {}),
      },
      update: {
        userID: userId,
        platform: dto.platform,
        provider: dto.provider,
        projectId: dto.projectId ?? null,
        appVersion: dto.appVersion ?? null,
        disabledAt: null,
        revocationSecretHash: revocationSecretHash ?? null,
      },
    });
    const findTokens = this.prisma.devicePushToken.findMany;
    if (!findTokens) return;
    const excess = await findTokens({
      where: { userID: userId, provider: dto.provider, disabledAt: null },
      orderBy: { updatedAt: 'desc' },
      skip: MAX_PUSH_TOKENS_PER_USER,
      select: { id: true },
    });
    if (excess.length > 0) {
      await this.prisma.devicePushToken.deleteMany({
        where: { id: { in: excess.map((row) => row.id) } },
      });
    }
  }

  async deletePushToken(userId: string, token: string): Promise<void> {
    await this.prisma.devicePushToken.deleteMany({
      where: {
        userID: userId,
        token,
      },
    });
  }

  async revokePushToken(dto: RevokePushTokenDto): Promise<boolean> {
    const result = await this.prisma.devicePushToken.deleteMany({
      where: {
        token: dto.token,
        revocationSecretHash: this.hashRevocationSecret(dto.revocationSecret),
      },
    });
    return result.count > 0;
  }

  private hashRevocationSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
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

    const notification = await this.createNotificationWithPush((tx) =>
      tx.notification.create({
        data: {
          toUserID: toUserId,
          fromUserID: fromUserId,
          type: NotificationType.SYSTEM,
          content,
        },
        include: NOTIFICATION_REALTIME_INCLUDE,
      }),
    );
    const dto = mapNotificationRealtimeDto(notification);
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
    fromFriendRequestID?: string;
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
    const notification = await this.prisma.$transaction(async (tx) => {
      if (dedupeWindowMs) {
        const duplicate = await tx.notification.findFirst({
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
        if (duplicate) return null;
      }

      const created = await tx.notification.create({
        data: {
          ...notificationData,
          content: notificationData.content ?? '',
        },
        include: NOTIFICATION_REALTIME_INCLUDE,
      });
      await tx.notificationPushOutbox.create({
        data: { notificationID: created.id },
      });
      return created;
    });
    if (!notification) return null;
    const dto = mapNotificationRealtimeDto(notification);
    return dto;
  }

  async createFriendRequestNotification(params: {
    type:
      | typeof NotificationType.FRIEND_REQUEST_RECEIVED
      | typeof NotificationType.FRIEND_REQUEST_ACCEPTED
      | typeof NotificationType.FRIEND_REQUEST_REJECTED
      | typeof NotificationType.FRIEND_REQUEST_MESSAGE;
    toUserId: string;
    fromUserId: string;
    content?: string | null;
    requestId?: string;
  }): Promise<NotificationRealtimeDto | null> {
    return this.createNotification({
      toUserID: params.toUserId,
      fromUserID: params.fromUserId,
      type: params.type,
      content: params.content ?? '',
      fromFriendRequestID: params.requestId,
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

  /**
   * "XX 赞了你的资料" —— 用户资料点赞（receivedLikeCount）产生的互动通知。
   * 归入互动类（DISCOVER），驱动铃铛列表 + 动态 tab 红点 + 横幅。点赞层已保证
   * 每人每天最多赞一次同一目标，dedupe window 只是并发兜底。
   */
  async createProfileLikeNotification(params: {
    actorId: string;
    toUserId: string;
  }): Promise<NotificationRealtimeDto | null> {
    return this.createNotification({
      toUserID: params.toUserId,
      fromUserID: params.actorId,
      type: NotificationType.PROFILE_LIKE,
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

    const notification = await this.createNotificationWithPush((tx) =>
      tx.notification.create({
        data: {
          toUserID: params.toUserId,
          fromUserID: params.toUserId,
          type: NotificationType.CIRCLE_POST_AUTO_ENDED,
          fromCirclePostID: params.postId,
          content: '',
        },
        include: NOTIFICATION_REALTIME_INCLUDE,
      }),
    );

    const dto = mapNotificationRealtimeDto(notification);
    return dto;
  }

  /**
   * "XX 认可了你的活动协作" —— 活动结束后作者提交合作认可时，通知每位被认可者。
   * fromUser 为作者、fromCirclePost 为对应动态；点击直达作者主页。认可是一次性
   * 事件（collaborationRecognizedAt 保证不可重复提交），故无需去重窗口。
   */
  async createCollaborationRecognitionNotification(params: {
    toUserId: string;
    fromUserId: string;
    postId: string;
  }): Promise<NotificationRealtimeDto | null> {
    return this.createNotification({
      toUserID: params.toUserId,
      fromUserID: params.fromUserId,
      type: NotificationType.CIRCLE_POST_COLLABORATION_RECOGNIZED,
      fromCirclePostID: params.postId,
    });
  }

  /**
   * "XX 在圈子发布了新活动" —— 在调用方事务内批量落库通知及 durable push
   * outbox，再回查带 fromUser/fromCirclePost 的 DTO 供提交后 realtime 广播。
   * recipientIds 由调用方保证已排除作者、被拉黑者、并去重。
   */
  async createCirclePostPublishedNotifications(
    tx: Prisma.TransactionClient,
    params: {
      postId: string;
      fromUserId: string;
      recipientIds: string[];
    },
  ): Promise<
    Array<{ toUserId: string; notification: NotificationRealtimeDto }>
  > {
    const recipients = Array.from(
      new Set(
        params.recipientIds.filter((id) => id && id !== params.fromUserId),
      ),
    );
    if (recipients.length === 0) {
      return [];
    }

    const created = await tx.notification.createManyAndReturn({
      data: recipients.map((toUserID) => ({
        toUserID,
        fromUserID: params.fromUserId,
        type: NotificationType.CIRCLE_POST_PUBLISHED,
        fromCirclePostID: params.postId,
        content: '',
      })),
      select: { id: true, toUserID: true },
    });

    await tx.notificationPushOutbox.createMany({
      data: created.map(({ id }) => ({ notificationID: id })),
    });

    const rows = await tx.notification.findMany({
      where: { id: { in: created.map(({ id }) => id) } },
      include: NOTIFICATION_REALTIME_INCLUDE,
    });

    return rows
      .filter(
        (row): row is typeof row & { toUserID: string } =>
          typeof row.toUserID === 'string',
      )
      .map((row) => ({
        toUserId: row.toUserID,
        notification: mapNotificationRealtimeDto(row),
      }));
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

  async getNotificationOpenOwnership(
    userId: string,
    id: string,
  ): Promise<{ owned: boolean }> {
    const notification = await this.prisma.notification.findFirst({
      where: { id, toUserID: userId, deleted: false },
      select: { id: true },
    });
    return { owned: notification !== null };
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
    mentionedUserIds?: string[];
    recheckMentionEligibility?: (mentionedUserIds: string[]) => Promise<{
      traceAvailable: boolean;
      eligibleUserIds: string[];
    }>;
    content: string;
  }): Promise<
    Array<{ targetUserId: string; notification: NotificationRealtimeDto }>
  > {
    const notifiedUserIds = new Set<string>();
    let mentionedUserIds = [...new Set(params.mentionedUserIds ?? [])].filter(
      (mentionedUserId) =>
        mentionedUserId && mentionedUserId !== params.actorId,
    );
    if (mentionedUserIds.length > 0 && params.recheckMentionEligibility) {
      const refreshed =
        await params.recheckMentionEligibility(mentionedUserIds);
      if (!refreshed.traceAvailable) return [];
      const requestedMentionIds = new Set(mentionedUserIds);
      mentionedUserIds = [...new Set(refreshed.eligibleUserIds)].filter((id) =>
        requestedMentionIds.has(id),
      );
    } else if (mentionedUserIds.length > 0) {
      // Mention recipients must be re-checked immediately before the write.
      // Callers that cannot provide that authorization snapshot fail closed.
      mentionedUserIds = [];
    }
    // Rows are assembled first so the whole fan-out is three statements rather
    // than two per recipient. Order encodes precedence: a user who is both the
    // trace owner and a mentionee gets only the highest-ranked notification.
    const rows: Prisma.NotificationCreateManyInput[] = [];
    if (
      params.traceOwnerId &&
      params.traceOwnerId !== params.actorId &&
      !notifiedUserIds.has(params.traceOwnerId)
    ) {
      notifiedUserIds.add(params.traceOwnerId);
      rows.push({
        toUserID: params.traceOwnerId,
        fromUserID: params.actorId,
        type: NotificationType.TRACE_COMMENT,
        content: params.content,
        fromTraceID: params.traceId,
        fromReplyID: params.commentId,
      });
    }
    if (
      params.replyToUserId &&
      params.replyToUserId !== params.actorId &&
      !notifiedUserIds.has(params.replyToUserId)
    ) {
      notifiedUserIds.add(params.replyToUserId);
      rows.push({
        toUserID: params.replyToUserId,
        fromUserID: params.actorId,
        type: NotificationType.COMMENT_REPLY,
        content: params.content,
        fromTraceID: params.traceId,
        fromReplyID: params.commentId,
        toReplyID: params.replyToCommentId ?? null,
      });
    }
    for (const mentionedUserId of mentionedUserIds) {
      if (notifiedUserIds.has(mentionedUserId)) continue;
      notifiedUserIds.add(mentionedUserId);
      rows.push({
        toUserID: mentionedUserId,
        fromUserID: params.actorId,
        type: NotificationType.TRACE_MENTION,
        content: params.content,
        fromTraceID: params.traceId,
        fromReplyID: params.commentId,
      });
    }
    if (rows.length === 0) return [];

    const created = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.notification.createManyAndReturn({
        data: rows,
        select: { id: true },
      });

      await tx.notificationPushOutbox.createMany({
        data: inserted.map(({ id }) => ({ notificationID: id })),
      });

      const hydrated = await tx.notification.findMany({
        where: { id: { in: inserted.map(({ id }) => id) } },
        include: NOTIFICATION_REALTIME_INCLUDE,
      });
      // findMany does not promise the insert order back, so restore it to keep
      // the precedence order above observable to callers.
      const byId = new Map(hydrated.map((row) => [row.id, row]));
      return inserted
        .map(({ id }) => byId.get(id))
        .filter((row): row is (typeof hydrated)[number] => row !== undefined);
    });

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
