import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { WebSocket } from 'ws';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import {
  DISCOVER_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from 'src/notification/notification.constants';
import type { NotificationRealtimeDto } from 'src/notification/notification.dto';

type BadgeSnapshot = {
  messagesUnread: number;
  contactsUnread: number;
  discoverUnread: number;
  signupUnread: number;
  profileUnread: number;
  systemUnread: number;
  syncedAt: string;
};

type CallUserLite = {
  id: string;
  nickname: string;
  avatarUrl: string | null;
};

type CallInvitePayload = {
  callId: string;
  conversationID: string;
  sessionType: 'group' | 'single';
  callType: 'AUDIO' | 'VIDEO';
  initiator: CallUserLite;
  invitees: CallUserLite[];
  expiresAt: string;
  createdAt: string;
};

type CallParticipantPayload = {
  callId: string;
  user: CallUserLite;
  joinedAt?: string;
  leftAt?: string;
  rejectedAt?: string;
  missedAt?: string;
  changedAt: string;
};

type CallStatePayload = {
  callId: string;
  status: 'ENDED' | 'CANCELED' | 'MISSED' | 'FAILED';
  endReason: string | null;
  endedAt: string | null;
  changedAt: string;
};

type MembershipStatusPayload = {
  vipLevel: number;
  expiredAt: string | null;
  changedAt: string;
};

type UserProfileSummaryPayload = {
  vipLevel: number;
  creditScore: number;
  displayIconsVersion: number;
  changedAt: string;
};

type RealtimeEvent =
  | { type: 'badge.snapshot'; payload: BadgeSnapshot }
  | { type: 'call.invite'; payload: CallInvitePayload }
  | { type: 'call.participant.joined'; payload: CallParticipantPayload }
  | { type: 'call.participant.left'; payload: CallParticipantPayload }
  | { type: 'call.participant.rejected'; payload: CallParticipantPayload }
  | { type: 'call.participant.missed'; payload: CallParticipantPayload }
  | { type: 'call.canceled'; payload: CallStatePayload }
  | { type: 'call.ended'; payload: CallStatePayload }
  | {
      type:
        | 'friend.activity.unread.changed'
        | 'interaction.unread.changed'
        | 'circle.signup.unread.changed'
        | 'system.notification.unread.changed';
      payload: { count: number; changedAt: string };
    }
  | {
      type: 'membership.status.changed';
      payload: MembershipStatusPayload;
    }
  | {
      type: 'wallet.balance.changed';
      payload: {
        delta: number | null;
        reason: string;
        changedAt: string;
      };
    }
  | {
      type: 'wallet.recharge.completed';
      payload: {
        delta: number;
        reason: 'RECHARGE';
        changedAt: string;
      };
    }
  | {
      type: 'circle.post.interaction.created';
      payload: {
        traceId: string;
        commentId: string;
        interactionType: 'COMMENT' | 'REPLY';
        actorId: string;
        actorNickname: string;
        changedAt: string;
      };
    }
  | {
      type: 'circle.invitation.reviewed';
      payload: {
        invitationId: string;
        circleId: string;
        status: string;
        changedAt: string;
      };
    }
  | {
      type: 'notification.created';
      payload: NotificationRealtimeDto;
    }
  | {
      type: 'system.notification.created';
      payload: {
        content: string;
        changedAt: string;
      };
    }
  | {
      type: 'user.profile.summary.changed';
      payload: UserProfileSummaryPayload;
    };

@Injectable()
export class RealtimeService implements OnModuleInit {
  private static readonly REDIS_CHANNEL_PREFIX = 'circle:realtime:user:';
  private static readonly REDIS_CHANNEL_PATTERN = `${RealtimeService.REDIS_CHANNEL_PREFIX}*`;
  private static readonly HOT_CACHE_PREFIX = 'circle:hot:user:';
  private static readonly BADGE_SNAPSHOT_TTL_SECONDS = 10;
  private static readonly PROFILE_SUMMARY_TTL_SECONDS = 30;
  private static readonly MEMBERSHIP_STATUS_TTL_SECONDS = 30;

  private readonly logger = new Logger(RealtimeService.name);
  private readonly clients = new Map<string, Set<WebSocket>>();
  private readonly instanceId = randomUUID();

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(RedisService)
    private readonly redisService?: RedisService,
  ) {}

  async onModuleInit() {
    await this.redisService?.subscribePattern(
      RealtimeService.REDIS_CHANNEL_PATTERN,
      (channel, message) => this.handleRedisRealtimeMessage(channel, message),
    );
  }

  registerClient(userId: string, socket: WebSocket) {
    const group = this.clients.get(userId) ?? new Set<WebSocket>();
    group.add(socket);
    this.clients.set(userId, group);
  }

  getConnectionCount(userId: string): number {
    return this.clients.get(userId)?.size ?? 0;
  }

  unregisterClient(userId: string, socket: WebSocket) {
    const group = this.clients.get(userId);
    if (!group) {
      return;
    }

    group.delete(socket);

    if (group.size === 0) {
      this.clients.delete(userId);
    }
  }

  async buildSnapshot(userId: string): Promise<BadgeSnapshot> {
    const cacheKey = this.badgeSnapshotCacheKey(userId);
    const cached = await this.redisService?.getJson<BadgeSnapshot>(cacheKey);
    if (cached) {
      return cached;
    }

    const [contactsUnread, discoverUnread, signupUnread, profileUnread] =
      await Promise.all([
        this.prisma.friendActivity.count({
          where: { viewerId: userId, readAt: null },
        }),
        this.prisma.notification.count({
          where: {
            toUserID: userId,
            deleted: false,
            read: false,
            type: { in: [...DISCOVER_NOTIFICATION_TYPES] },
          },
        }),
        this.countUnreadSignups(userId),
        this.prisma.notification.count({
          where: {
            toUserID: userId,
            deleted: false,
            read: false,
            type: { in: [...PROFILE_NOTIFICATION_TYPES] },
          },
        }),
      ]);

    const snapshot = {
      messagesUnread: 0,
      contactsUnread,
      discoverUnread,
      signupUnread,
      profileUnread,
      systemUnread: profileUnread,
      syncedAt: new Date().toISOString(),
    };
    await this.redisService?.setJson(
      cacheKey,
      snapshot,
      RealtimeService.BADGE_SNAPSHOT_TTL_SECONDS,
    );
    return snapshot;
  }

  async emitSnapshot(userId: string) {
    const snapshot = await this.buildSnapshot(userId);
    this.broadcast(userId, {
      type: 'badge.snapshot',
      payload: snapshot,
    });
  }

  async broadcastFriendUnreadCount(userId: string) {
    await this.invalidateBadgeSnapshotCache(userId);
    const count = await this.prisma.friendActivity.count({
      where: { viewerId: userId, readAt: null },
    });

    this.broadcast(userId, {
      type: 'friend.activity.unread.changed',
      payload: {
        count,
        changedAt: new Date().toISOString(),
      },
    });
  }

  /** Unseen signups across the posts this user authored (signup-management badge). */
  private countUnreadSignups(userId: string): Promise<number> {
    return this.prisma.circlePostSignup.count({
      where: {
        seenByAuthor: false,
        post: { authorID: userId, status: 'ACTIVE' },
      },
    });
  }

  /** "互动消息" unread — trace comments/replies + circle verification/invitation. */
  async broadcastInteractionUnread(userId: string) {
    await this.invalidateBadgeSnapshotCache(userId);
    const count = await this.prisma.notification.count({
      where: {
        toUserID: userId,
        deleted: false,
        read: false,
        type: { in: [...DISCOVER_NOTIFICATION_TYPES] },
      },
    });

    this.broadcast(userId, {
      type: 'interaction.unread.changed',
      payload: {
        count,
        changedAt: new Date().toISOString(),
      },
    });
  }

  /** "报名管理" unread — unseen signups on the author's own posts. */
  async broadcastSignupUnread(userId: string) {
    await this.invalidateBadgeSnapshotCache(userId);
    const count = await this.countUnreadSignups(userId);

    this.broadcast(userId, {
      type: 'circle.signup.unread.changed',
      payload: {
        count,
        changedAt: new Date().toISOString(),
      },
    });
  }

  async broadcastSystemNotificationUnread(userId: string) {
    await this.invalidateBadgeSnapshotCache(userId);
    const count = await this.prisma.notification.count({
      where: {
        toUserID: userId,
        deleted: false,
        read: false,
        type: { in: [...PROFILE_NOTIFICATION_TYPES] },
      },
    });

    this.broadcast(userId, {
      type: 'system.notification.unread.changed',
      payload: {
        count,
        changedAt: new Date().toISOString(),
      },
    });
  }

  async broadcastMembershipStatus(userId: string) {
    const payload = await this.getMembershipStatusPayload(userId);
    if (!payload) {
      return;
    }

    this.broadcast(userId, {
      type: 'membership.status.changed',
      payload,
    });
  }

  private async getMembershipStatusPayload(
    userId: string,
  ): Promise<MembershipStatusPayload | null> {
    const cacheKey = this.membershipStatusCacheKey(userId);
    const cached =
      await this.redisService?.getJson<MembershipStatusPayload>(cacheKey);
    if (cached) {
      return cached;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipLevel: true },
    });
    if (!user) {
      return null;
    }

    const payload = {
      vipLevel: user.vipLevel,
      expiredAt: null,
      changedAt: new Date().toISOString(),
    };
    await this.redisService?.setJson(
      cacheKey,
      payload,
      RealtimeService.MEMBERSHIP_STATUS_TTL_SECONDS,
    );
    return payload;
  }

  /**
   * Signals that the wallet balance has changed. Does NOT include the absolute
   * balance — the client refetches via the wallet REST endpoint to avoid
   * leaking PII over the WebSocket transport.
   */
  broadcastWalletBalanceChanged(
    userId: string,
    payload?: { reason?: string; delta?: number | null },
  ) {
    this.broadcast(userId, {
      type: 'wallet.balance.changed',
      payload: {
        delta: payload?.delta ?? null,
        reason: payload?.reason ?? 'UNKNOWN',
        changedAt: new Date().toISOString(),
      },
    });
  }

  broadcastWalletRechargeCompleted(userId: string, amount: number) {
    this.broadcast(userId, {
      type: 'wallet.recharge.completed',
      payload: {
        delta: amount,
        reason: 'RECHARGE',
        changedAt: new Date().toISOString(),
      },
    });
  }

  broadcastCirclePostInteractionCreated(
    userId: string,
    payload: {
      traceId: string;
      commentId: string;
      interactionType: 'COMMENT' | 'REPLY';
      actorId: string;
      actorNickname: string;
    },
  ) {
    this.broadcast(userId, {
      type: 'circle.post.interaction.created',
      payload: {
        ...payload,
        changedAt: new Date().toISOString(),
      },
    });
  }

  broadcastCircleInvitationReviewed(
    userId: string,
    payload: { invitationId: string; circleId: string; status: string },
  ) {
    this.broadcast(userId, {
      type: 'circle.invitation.reviewed',
      payload: {
        ...payload,
        changedAt: new Date().toISOString(),
      },
    });
  }

  broadcastNotificationCreated(
    userId: string,
    notification: NotificationRealtimeDto,
  ) {
    this.broadcast(userId, {
      type: 'notification.created',
      payload: notification,
    });
  }

  broadcastCallInvite(userId: string, payload: CallInvitePayload) {
    this.broadcast(userId, {
      type: 'call.invite',
      payload,
    });
  }

  broadcastCallParticipantJoined(
    userId: string,
    payload: CallParticipantPayload,
  ) {
    this.broadcast(userId, {
      type: 'call.participant.joined',
      payload,
    });
  }

  broadcastCallParticipantLeft(
    userId: string,
    payload: CallParticipantPayload,
  ) {
    this.broadcast(userId, {
      type: 'call.participant.left',
      payload,
    });
  }

  broadcastCallParticipantRejected(
    userId: string,
    payload: CallParticipantPayload,
  ) {
    this.broadcast(userId, {
      type: 'call.participant.rejected',
      payload,
    });
  }

  broadcastCallParticipantMissed(
    userId: string,
    payload: CallParticipantPayload,
  ) {
    this.broadcast(userId, {
      type: 'call.participant.missed',
      payload,
    });
  }

  broadcastCallCanceled(userId: string, payload: CallStatePayload) {
    this.broadcast(userId, {
      type: 'call.canceled',
      payload,
    });
  }

  broadcastCallEnded(userId: string, payload: CallStatePayload) {
    this.broadcast(userId, {
      type: 'call.ended',
      payload,
    });
  }

  broadcastSystemNotificationCreated(userId: string, content: string) {
    this.broadcast(userId, {
      type: 'system.notification.created',
      payload: {
        content,
        changedAt: new Date().toISOString(),
      },
    });
  }

  async broadcastUserProfileSummary(userId: string) {
    const payload = await this.getUserProfileSummaryPayload(userId);
    if (!payload) {
      return;
    }

    this.broadcast(userId, {
      type: 'user.profile.summary.changed',
      payload,
    });
  }

  private async getUserProfileSummaryPayload(
    userId: string,
  ): Promise<UserProfileSummaryPayload | null> {
    const cacheKey = this.userProfileSummaryCacheKey(userId);
    const cached =
      await this.redisService?.getJson<UserProfileSummaryPayload>(cacheKey);
    if (cached) {
      return cached;
    }

    const [user, latestDisplayIcon] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { vipLevel: true, creditScore: true },
      }),
      this.prisma.userDisplayIcon.findFirst({
        where: { userID: userId },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);

    if (!user) {
      return null;
    }

    const payload = {
      vipLevel: user.vipLevel,
      creditScore: user.creditScore,
      displayIconsVersion: latestDisplayIcon?.updatedAt.getTime() ?? Date.now(),
      changedAt: new Date().toISOString(),
    };
    await this.redisService?.setJson(
      cacheKey,
      payload,
      RealtimeService.PROFILE_SUMMARY_TTL_SECONDS,
    );
    return payload;
  }

  async invalidateUserHotCache(userId: string): Promise<void> {
    await Promise.all([
      this.invalidateBadgeSnapshotCache(userId),
      this.invalidateMembershipStatusCache(userId),
      this.invalidateUserProfileSummaryCache(userId),
    ]);
  }

  async invalidateMembershipStatusCache(userId: string): Promise<void> {
    await this.redisService?.deleteKey(this.membershipStatusCacheKey(userId));
  }

  async invalidateUserProfileSummaryCache(userId: string): Promise<void> {
    await this.redisService?.deleteKey(this.userProfileSummaryCacheKey(userId));
  }

  /**
   * Fire-and-forget broadcast that never throws.
   * Call this from service methods that run after a successful business operation
   * so that a WS failure doesn't crash the HTTP response.
   */
  async safeBroadcastAll(
    fns: Array<() => void | Promise<void>>,
  ): Promise<void> {
    await Promise.allSettled(
      fns.map(async (fn) => {
        try {
          await fn();
        } catch (error) {
          this.logger.warn(
            `Realtime broadcast failed: ${error instanceof Error ? error.message : error}`,
          );
        }
      }),
    );
  }

  broadcast(userId: string, event: RealtimeEvent) {
    this.deliverLocal(userId, event);
    void this.publishCrossInstance(userId, event);
  }

  private deliverLocal(userId: string, event: RealtimeEvent) {
    const group = this.clients.get(userId);
    if (!group || group.size === 0) {
      return;
    }

    const message = JSON.stringify(event);

    for (const socket of group) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(message);
        } catch (error) {
          this.logger.warn(
            `Failed to send to socket for ${userId}: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    }
  }

  private async publishCrossInstance(userId: string, event: RealtimeEvent) {
    const published = await this.redisService?.publish(
      `${RealtimeService.REDIS_CHANNEL_PREFIX}${userId}`,
      JSON.stringify({ origin: this.instanceId, event }),
    );

    if (published === false) {
      this.logger.debug(
        `Redis realtime backplane unavailable; delivered event locally for ${userId}.`,
      );
    }
  }

  private async invalidateBadgeSnapshotCache(userId: string): Promise<void> {
    await this.redisService?.deleteKey(this.badgeSnapshotCacheKey(userId));
  }

  private badgeSnapshotCacheKey(userId: string): string {
    return `${RealtimeService.HOT_CACHE_PREFIX}${userId}:badge-snapshot`;
  }

  private membershipStatusCacheKey(userId: string): string {
    return `${RealtimeService.HOT_CACHE_PREFIX}${userId}:membership-status`;
  }

  private userProfileSummaryCacheKey(userId: string): string {
    return `${RealtimeService.HOT_CACHE_PREFIX}${userId}:profile-summary`;
  }

  private handleRedisRealtimeMessage(channel: string, message: string) {
    if (!channel.startsWith(RealtimeService.REDIS_CHANNEL_PREFIX)) {
      return;
    }

    const userId = channel.slice(RealtimeService.REDIS_CHANNEL_PREFIX.length);
    if (!userId) {
      return;
    }

    const envelope = this.parseRedisEnvelope(message);
    if (!envelope || envelope.origin === this.instanceId) {
      return;
    }

    this.deliverLocal(userId, envelope.event);
  }

  private parseRedisEnvelope(
    message: string,
  ): { origin: string; event: RealtimeEvent } | null {
    try {
      const parsed: unknown = JSON.parse(message);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }
      const envelope = parsed as {
        origin?: unknown;
        event?: unknown;
      };
      if (typeof envelope.origin !== 'string') {
        return null;
      }
      if (!this.isRealtimeEvent(envelope.event)) {
        return null;
      }
      return { origin: envelope.origin, event: envelope.event };
    } catch {
      return null;
    }
  }

  private isRealtimeEvent(event: unknown): event is RealtimeEvent {
    return (
      !!event &&
      typeof event === 'object' &&
      typeof (event as { type?: unknown }).type === 'string' &&
      'payload' in event
    );
  }
}
