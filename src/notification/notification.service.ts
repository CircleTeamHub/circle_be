import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { NotificationType, Prisma, UserStatus } from 'src/generated/prisma';
import { AdminAuditService } from 'src/moderation/admin-audit.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { RealtimeService } from 'src/realtime/realtime.service';
import {
  CIRCLE_NOTIFICATION_TYPES,
  DISCOVER_NOTIFICATION_TYPES,
  MOMENT_NOTIFICATION_TYPES,
  notificationTypesForDomain,
  PROFILE_NOTIFICATION_TYPES,
  type NotificationDomain,
} from './notification.constants';
import {
  mapNotificationRealtimeDto,
  NOTIFICATION_REALTIME_INCLUDE,
  type NotificationRealtimeRow,
  type RegisterPushTokenDto,
  type NotificationRealtimeDto,
  type PublishSystemAnnouncementDto,
  type RevokePushTokenDto,
} from './notification.dto';
import { NotificationPushService } from './notification-push.service';

const NOTIFICATION_DEDUPE_WINDOW_MS = 60 * 60 * 1000;
const SYSTEM_ANNOUNCEMENT_BATCH_SIZE = 500;
const SYSTEM_ANNOUNCEMENT_BROADCAST_BATCH_SIZE = 50;
// #98 显式决定：保持 20 而不是原计划的 10。多设备（手机+平板+重装残留）在
// 20 内都装得下，超限按 lastSeen 逐出最旧的；收紧到 10 只会更快逐出仍然
// 活跃的次要设备，没有对应的安全收益（token 本身不可伪造投递身份）。
const MAX_PUSH_TOKENS_PER_USER = 20;

type SystemAnnouncementAuditContext = {
  ip?: string | null;
  userAgent?: string | null;
};

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Prisma 唯一约束冲突（P2002）。 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private announcementFanoutInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtimeService: RealtimeService,
    // Kept optional for compatibility with direct service consumers; delivery
    // itself is handled by the durable push outbox processor.
    @Optional()
    private readonly pushService?: NotificationPushService,
    @Optional()
    private readonly auditService?: AdminAuditService,
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

    // 换绑保护：upsert 的键是 token 本身。没有这道校验的话，任何拿到别人设备令牌的人
    // 都能把它改挂到自己账号下 —— 受害者从此收不到自己的推送，反而会在锁屏上收到
    // 攻击者的通知；而且这次 update 还会把原有的 revocationSecretHash 直接置空，
    // 把设备侧的撤销能力一并抹掉。
    // 规则：令牌已属于别人时，必须出示与登记时一致的 revocationSecret 才允许换绑
    // （同一台设备换账号登录是正常场景，客户端本来就持有这个 secret）。
    //
    // 归属判定必须与写入是同一条语句。先 findUnique 再 upsert 的话中间有窗口：
    // 两个账号同时登记一个此前没见过的令牌，都会读到「无主」，后写的那个直接
    // 把令牌抢走且完全没出示过 secret；同样的读-改-写竞态也会覆盖掉这期间
    // 别人刚改的归属或 secret。
    // 做法：带归属谓词的条件更新 → 命中即完成；未命中就尝试 create，
    // 撞唯一约束(P2002)说明行确实存在但谓词不满足 = 属于别人且没证明 → 拒绝。
    const update = {
      userID: userId,
      platform: dto.platform,
      provider: dto.provider,
      projectId: dto.projectId ?? null,
      appVersion: dto.appVersion ?? null,
      disabledAt: null,
      // 只在本次确实带了 secret 时才写。用 `?? null` 的话，老客户端(或任何一次
      // 不带 secret 的重新登记)会把已有的撤销密钥抹成 null —— 这台设备的令牌
      // 就从「受保护」降级回「谁知道令牌谁就能抢」，等于自己把下面那道闸拆了。
      ...(revocationSecretHash ? { revocationSecretHash } : {}),
    };
    const claimed = await this.prisma.devicePushToken.updateMany({
      where: {
        token: dto.token,
        OR: [
          { userID: userId },
          ...(revocationSecretHash ? [{ revocationSecretHash }] : []),
          // 迁移通道：secret 是可选字段，存量行(以及任何没带 secret 登记过的
          // 客户端)的 revocationSecretHash 是 null。不放行的话，同一台设备换个
          // 账号登录就永远命中不了谓词 → create 撞唯一约束 → 403，而且是**永久**
          // 的:直到推送服务商轮换令牌为止，新账号一条推送都收不到。
          //
          // 放行 null 行不是新开口子 —— 修复前所有行都能这么抢，这里只是没能
          // 追溯保护「本来就没有 secret」的那部分。带了 secret 的行依然抢不走，
          // 而认领方一旦带上 secret，上面的 update 会顺手把这行升级成受保护，
          // 存量因此会随客户端升级自然收敛。
          { revocationSecretHash: null },
        ],
      },
      data: update,
    });
    if (claimed.count === 0) {
      try {
        await this.prisma.devicePushToken.create({
          data: {
            token: dto.token,
            userID: userId,
            platform: dto.platform,
            provider: dto.provider,
            projectId: dto.projectId ?? null,
            appVersion: dto.appVersion ?? null,
            ...(revocationSecretHash ? { revocationSecretHash } : {}),
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // 行存在但归属谓词没命中 —— 属于别人且没出示正确的 secret。
        this.logger.warn(
          `Rejected push-token rebind: token is owned by another account (requester=${userId})`,
        );
        throw new ForbiddenException('Push token belongs to another account');
      }
    }

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
    // momentsUnread / circleUnread 各自喂一个铃铛（朋友圈 / 圈子广场）；
    // discoverUnread 仍是整个互动域的总数，老客户端和 tab 徽标继续读它。
    const [discoverUnread, momentsUnread, circleUnread, profileUnread] =
      await Promise.all([
        this.countUnreadByTypes(userId, DISCOVER_NOTIFICATION_TYPES),
        this.countUnreadByTypes(userId, MOMENT_NOTIFICATION_TYPES),
        this.countUnreadByTypes(userId, CIRCLE_NOTIFICATION_TYPES),
        this.countUnreadByTypes(userId, PROFILE_NOTIFICATION_TYPES),
      ]);

    return {
      discoverUnread,
      momentsUnread,
      circleUnread,
      profileUnread,
      totalUnread: discoverUnread + profileUnread,
    };
  }

  private countUnreadByTypes(
    userId: string,
    types: readonly NotificationType[],
  ): Promise<number> {
    return this.prisma.notification.count({
      where: {
        toUserID: userId,
        deleted: false,
        read: false,
        type: { in: [...types] },
      },
    });
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

  async publishSystemAnnouncement(
    operatorId: string,
    dto: PublishSystemAnnouncementDto,
    idempotencyKey: string,
    auditContext?: SystemAnnouncementAuditContext,
  ): Promise<{ createdCount: number }> {
    if (this.announcementFanoutInFlight) {
      throw new HttpException(
        'A system announcement publish is already in progress',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.announcementFanoutInFlight = true;
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
            SELECT pg_try_advisory_xact_lock(
              hashtext('circle-system-announcement-fanout')
            ) AS acquired
          `;
          if (!rows[0]?.acquired) {
            throw new HttpException(
              'A system announcement publish is already in progress',
              HttpStatus.TOO_MANY_REQUESTS,
            );
          }
          return this.publishSystemAnnouncementOnce(
            operatorId,
            dto,
            idempotencyKey,
            auditContext,
          );
        },
        { maxWait: 5_000, timeout: 600_000 },
      );
    } finally {
      this.announcementFanoutInFlight = false;
    }
  }

  private async publishSystemAnnouncementOnce(
    operatorId: string,
    dto: PublishSystemAnnouncementDto,
    idempotencyKey: string,
    auditContext?: SystemAnnouncementAuditContext,
  ): Promise<{ createdCount: number }> {
    const requestFingerprint = `${operatorId}:${dto.content}`;
    const announcement = await this.prisma.systemAnnouncement.upsert({
      where: { idempotencyKey },
      create: {
        idempotencyKey,
        requestFingerprint,
        operatorID: operatorId,
        content: dto.content,
      },
      update: {},
      select: {
        id: true,
        requestFingerprint: true,
        createdAt: true,
        auditRecordedAt: true,
        fanoutCompletedAt: true,
        recipientCount: true,
      },
    });
    if (announcement.requestFingerprint !== requestFingerprint) {
      throw new ConflictException(
        'Idempotency-Key has already been used for another announcement',
      );
    }

    let createdCount = announcement.recipientCount ?? 0;
    if (!announcement.fanoutCompletedAt) {
      let cursor: string | undefined;
      while (true) {
        const recipients = await this.prisma.user.findMany({
          where: {
            status: UserStatus.ACTIVE,
            createdAt: { lte: announcement.createdAt },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: SYSTEM_ANNOUNCEMENT_BATCH_SIZE,
        });
        if (recipients.length === 0) break;
        const recipientIds = recipients.map(({ id }) => id);
        const inserted = await this.prisma.$transaction(async (tx) => {
          const rows = await tx.notification.createManyAndReturn({
            data: recipientIds.map((toUserID) => ({
              toUserID,
              fromUserID: operatorId,
              type: NotificationType.SYSTEM,
              content: dto.content,
              systemAnnouncementID: announcement.id,
            })),
            skipDuplicates: true,
            select: { id: true, toUserID: true },
          });

          if (rows.length > 0) {
            await tx.notificationPushOutbox.createMany({
              data: rows.map(({ id }) => ({ notificationID: id })),
            });
          }

          return rows;
        });
        const createdUserIds = inserted
          .map(({ toUserID }) => toUserID)
          .filter((userId): userId is string => typeof userId === 'string');
        for (const batch of chunkArray(
          createdUserIds,
          SYSTEM_ANNOUNCEMENT_BROADCAST_BATCH_SIZE,
        )) {
          await Promise.allSettled(
            batch.map((userId) =>
              this.realtimeService.broadcastSystemNotificationUnread(userId),
            ),
          );
        }

        cursor = recipientIds[recipientIds.length - 1];
        if (recipients.length < SYSTEM_ANNOUNCEMENT_BATCH_SIZE) break;
      }

      createdCount = await this.prisma.notification.count({
        where: { systemAnnouncementID: announcement.id },
      });
      const completedAt = new Date();
      const completed = await this.prisma.systemAnnouncement.updateMany({
        where: { id: announcement.id, fanoutCompletedAt: null },
        data: { fanoutCompletedAt: completedAt, recipientCount: createdCount },
      });
      if (completed.count === 0) {
        const persisted =
          await this.prisma.systemAnnouncement.findUniqueOrThrow({
            where: { id: announcement.id },
            select: { recipientCount: true },
          });
        createdCount = persisted.recipientCount ?? 0;
      }
    }
    if (this.auditService) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const claimed = await tx.systemAnnouncement.updateMany({
            where: { id: announcement.id, auditRecordedAt: null },
            data: { auditRecordedAt: new Date() },
          });
          if (claimed.count === 0) return;
          await this.auditService!.recordStrict(tx, {
            actorID: operatorId,
            action: 'system_announcement_publish',
            entityType: 'SystemAnnouncement',
            entityID: announcement.id,
            after: {
              content: dto.content,
              createdCount,
            },
            ip: auditContext?.ip ?? null,
            userAgent: auditContext?.userAgent ?? null,
          });
        });
      } catch (error) {
        this.logger.warn(
          `Secondary audit logging failed for persisted system announcement ${announcement.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return { createdCount };
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

  async getNotifications(
    userId: string,
    page = 1,
    domain?: NotificationDomain,
  ) {
    const take = 20;
    const skip = (Math.max(1, page) - 1) * take;
    const rows = await this.prisma.notification.findMany({
      where: {
        toUserID: userId,
        deleted: false,
        type: { in: [...notificationTypesForDomain(domain)] },
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

  // domain 收窄「全部已读」的作用范围：朋友圈铃铛的「全部已读」不该顺手把
  // 圈子通知也清了，反之亦然。不传 domain 时行为与老客户端一致（清全域）。
  async markAllNotificationsRead(
    userId: string,
    domain?: NotificationDomain,
  ): Promise<{ count: number }> {
    const result = await this.prisma.notification.updateMany({
      where: {
        toUserID: userId,
        deleted: false,
        read: false,
        type: { in: [...notificationTypesForDomain(domain)] },
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
