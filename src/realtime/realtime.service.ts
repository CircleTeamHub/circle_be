import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
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
import {
  SESSION_REVOCATION_CHANNEL,
  parseSessionRevocationBroadcast,
  type SessionRevocationBroadcast,
} from 'src/auth/session-revocation.broadcast';

/**
 * Close frame sent to a socket whose session was revoked. 1008 (policy
 * violation) matches every other rejection in the gateway; the reason mirrors
 * the HTTP side's `UnauthorizedException('Session revoked')` so a client can
 * tell "you are no longer authorized, stop retrying" from a transient drop.
 *
 * ⚠️ 跨仓字符串契约（#102）：REVOKED_CLOSE_REASON 必须与
 *   Circle_frontend/src/realtime/client.ts 的 REVOKED_CLOSE_REASON
 * 逐字节一致 —— 网关对六种拒绝都发 1008，reason 是客户端判「终态、停止重连」
 * 的唯一依据。任何一侧改词、两边测试都不会互相报警，撤销登出会静默退化成
 * 重连环直到 JWT 过期。改动必须两仓同步 + 双方 pin 测试同步更新
 * （本仓 src/realtime/revoked-close-contract.spec.ts）。
 */
export const REVOKED_CLOSE_CODE = 1008;
export const REVOKED_CLOSE_REASON = 'Session revoked';

/**
 * Per-socket claims needed to decide whether a revocation applies, mirroring
 * what `SessionRevocationService.isRevoked` reads off the JWT.
 */
export type RealtimeSocketIdentity = {
  /** `sid` claim; null when the token predates session ids. */
  sessionId: string | null;
  /** `issuedAtMs` (or `iat` x1000); null when the token carries neither. */
  issuedAtMs: number | null;
};

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
  | {
      type: 'moments.feed.updated';
      payload: { authorId: string; changedAt: string };
    }
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
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private static readonly REDIS_CHANNEL_PREFIX = 'circle:realtime:user:';
  private static readonly REDIS_CHANNEL_PATTERN = `${RealtimeService.REDIS_CHANNEL_PREFIX}*`;
  private static readonly HOT_CACHE_PREFIX = 'circle:hot:user:';
  private static readonly BADGE_SNAPSHOT_TTL_SECONDS = 10;
  private static readonly PROFILE_SUMMARY_TTL_SECONDS = 30;
  private static readonly MEMBERSHIP_STATUS_TTL_SECONDS = 30;
  private static readonly SUBSCRIPTION_RETRY_BASE_MS = 1_000;
  private static readonly SUBSCRIPTION_RETRY_MAX_MS = 30_000;
  /** Allow-list of event types accepted off the Redis backplane. */
  private static readonly REALTIME_EVENT_TYPES: ReadonlySet<string> = new Set([
    'badge.snapshot',
    'moments.feed.updated',
    'call.invite',
    'call.participant.joined',
    'call.participant.left',
    'call.participant.rejected',
    'call.participant.missed',
    'call.canceled',
    'call.ended',
    'friend.activity.unread.changed',
    'interaction.unread.changed',
    'circle.signup.unread.changed',
    'system.notification.unread.changed',
    'membership.status.changed',
    'wallet.balance.changed',
    'wallet.recharge.completed',
    'circle.post.interaction.created',
    'circle.invitation.reviewed',
    'notification.created',
    'system.notification.created',
    'user.profile.summary.changed',
  ]);

  private readonly logger = new Logger(RealtimeService.name);
  private readonly clients = new Map<string, Set<WebSocket>>();
  /** Claims per live socket, used to match incoming revocations. */
  private readonly socketIdentities = new WeakMap<
    WebSocket,
    RealtimeSocketIdentity
  >();
  private readonly instanceId = randomUUID();
  /** De-dupes concurrent cache-miss recomputes for the same key within this instance. */
  private readonly inFlightReads = new Map<string, Promise<unknown>>();
  private subscriptionActive = false;
  /**
   * Tracked separately so a partial failure retries only the missing half —
   * re-subscribing an already-active pattern would double-deliver every event.
   */
  private eventSubscriptionActive = false;
  private revocationSubscriptionActive = false;
  private subscriptionRetryTimer: NodeJS.Timeout | null = null;
  private subscriptionRetryAttempt = 0;
  private destroyed = false;
  /**
   * Count of cross-instance messages received for users NOT connected locally.
   * Because every instance psubscribes `circle:realtime:user:*`, each instance
   * sees every user's events and discards the ones it doesn't hold. A high ratio
   * here signals the global-fanout pub/sub is becoming a scaling bottleneck and
   * should be replaced by per-user / per-instance routing.
   */
  private crossInstanceIgnored = 0;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    @Inject(RedisService)
    private readonly redisService?: RedisService,
  ) {}

  async onModuleInit() {
    await this.ensureBackplaneSubscription();
  }

  onModuleDestroy() {
    this.destroyed = true;
    if (this.subscriptionRetryTimer) {
      clearTimeout(this.subscriptionRetryTimer);
      this.subscriptionRetryTimer = null;
    }
  }

  /** Observability hook: cross-instance messages discarded for non-local users. */
  getCrossInstanceIgnoredCount(): number {
    return this.crossInstanceIgnored;
  }

  /**
   * Establishes the Redis pub/sub subscription, retrying with backoff if Redis
   * is unreachable at boot. Without this, a Redis outage during startup would
   * leave the instance permanently deaf to cross-instance events (it would still
   * publish, but never receive) until the process restarts.
   */
  private async ensureBackplaneSubscription(): Promise<void> {
    if (
      this.destroyed ||
      this.subscriptionActive ||
      !this.redisService?.isEnabled()
    ) {
      return;
    }

    if (!this.eventSubscriptionActive) {
      this.eventSubscriptionActive = await this.redisService.subscribePattern(
        RealtimeService.REDIS_CHANNEL_PATTERN,
        (channel, message) => this.handleRedisRealtimeMessage(channel, message),
      );
    }

    // Deliberately a second subscription rather than folding revocations into
    // `circle:realtime:user:*`: everything on that channel is forwarded verbatim
    // to clients (guarded by the REALTIME_EVENT_TYPES allow-list), whereas a
    // revocation is a control-plane action that closes the socket instead. It
    // reuses the same backplane machinery — publish, psubscribe, and the retry
    // loop below — without widening what can reach a client.
    if (!this.revocationSubscriptionActive) {
      this.revocationSubscriptionActive =
        await this.redisService.subscribePattern(
          SESSION_REVOCATION_CHANNEL,
          (_channel, message) => this.handleRevocationMessage(message),
        );
    }

    if (this.eventSubscriptionActive && this.revocationSubscriptionActive) {
      this.subscriptionActive = true;
      this.subscriptionRetryAttempt = 0;
      return;
    }

    this.scheduleSubscriptionRetry();
  }

  private scheduleSubscriptionRetry(): void {
    if (this.destroyed || this.subscriptionRetryTimer) {
      return;
    }

    const delay = Math.min(
      RealtimeService.SUBSCRIPTION_RETRY_BASE_MS *
        2 ** this.subscriptionRetryAttempt,
      RealtimeService.SUBSCRIPTION_RETRY_MAX_MS,
    );
    this.subscriptionRetryAttempt += 1;
    this.logger.warn(
      `Realtime backplane subscription inactive; retrying in ${delay}ms.`,
    );

    this.subscriptionRetryTimer = setTimeout(() => {
      this.subscriptionRetryTimer = null;
      void this.ensureBackplaneSubscription();
    }, delay);
    // Don't keep the process alive solely for this retry timer.
    this.subscriptionRetryTimer.unref?.();
  }

  /**
   * Runs `compute` at most once per `key` while it is in flight, so a burst of
   * concurrent cache misses for the same user issues a single DB read instead of
   * a stampede. Purely in-process; cross-instance safety comes from the
   * versioned cache writes (setJsonIfNewer).
   */
  private singleFlight<T>(key: string, compute: () => Promise<T>): Promise<T> {
    const existing = this.inFlightReads.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const promise = compute().finally(() => {
      this.inFlightReads.delete(key);
    });
    this.inFlightReads.set(key, promise);
    return promise;
  }

  registerClient(
    userId: string,
    socket: WebSocket,
    identity?: RealtimeSocketIdentity,
  ) {
    const group = this.clients.get(userId) ?? new Set<WebSocket>();
    group.add(socket);
    this.clients.set(userId, group);
    if (identity) {
      this.socketIdentities.set(socket, identity);
    }
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

    return this.singleFlight(cacheKey, async () => {
      let snapshot: BadgeSnapshot | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const version = await this.redisService?.getVersion(
          this.badgeSnapshotVersionKey(userId),
        );
        snapshot = await this.queryBadgeSnapshot(userId);
        if (version === undefined || version === null) {
          return snapshot;
        }
        const stored = await this.redisService?.setJsonIfVersionMatches(
          cacheKey,
          this.badgeSnapshotVersionKey(userId),
          version,
          snapshot,
          RealtimeService.BADGE_SNAPSHOT_TTL_SECONDS,
        );
        if (stored) return snapshot;
      }
      return snapshot as BadgeSnapshot;
    });
  }

  private async queryBadgeSnapshot(userId: string): Promise<BadgeSnapshot> {
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

    const snapshot: BadgeSnapshot = {
      messagesUnread: 0,
      contactsUnread,
      discoverUnread,
      signupUnread,
      profileUnread,
      systemUnread: profileUnread,
      syncedAt: new Date().toISOString(),
    };
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
      await this.redisService?.getJsonWithVersion<MembershipStatusPayload>(
        cacheKey,
      );
    if (cached) {
      return cached.payload;
    }

    return this.singleFlight(cacheKey, async () => {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { vipLevel: true, updatedAt: true },
      });
      if (!user) {
        return null;
      }

      const payload: MembershipStatusPayload = {
        vipLevel: user.vipLevel,
        expiredAt: null,
        changedAt: new Date().toISOString(),
      };
      // Version-guarded write: a slow reader holding a pre-update value can't
      // clobber a fresher one (the mutation bumps user.updatedAt).
      await this.redisService?.setJsonIfNewer(
        cacheKey,
        payload,
        user.updatedAt.getTime(),
        RealtimeService.MEMBERSHIP_STATUS_TTL_SECONDS,
      );
      return payload;
    });
  }

  /**
   * Signals that the wallet balance has changed. Does NOT include the absolute
   * balance — the client refetches via the wallet REST endpoint to avoid
   * leaking PII over the WebSocket transport.
   */
  /**
   * 朋友圈动态变更 poke（#89：客户端弃 30s 轮询改事件驱动）。
   * 轻量「去拉一次」信号，不携带内容 —— 客户端收到后自行 refetch feed，
   * 负载形状与权限过滤完全复用既有 GET /trace/feed。
   */
  broadcastMomentsFeedUpdated(userId: string, payload: { authorId: string }) {
    this.broadcast(userId, {
      type: 'moments.feed.updated',
      payload: {
        authorId: payload.authorId,
        changedAt: new Date().toISOString(),
      },
    });
  }

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
      await this.redisService?.getJsonWithVersion<UserProfileSummaryPayload>(
        cacheKey,
      );
    if (cached) {
      return cached.payload;
    }

    return this.singleFlight(cacheKey, async () => {
      const [user, latestDisplayIcon] = await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: { vipLevel: true, creditScore: true, updatedAt: true },
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

      const displayIconsUpdatedAt = latestDisplayIcon?.updatedAt.getTime() ?? 0;
      const payload: UserProfileSummaryPayload = {
        vipLevel: user.vipLevel,
        creditScore: user.creditScore,
        // Stable for icon-less users (0) so the cached payload doesn't churn on
        // every recompute and trigger needless client refetches.
        displayIconsVersion: displayIconsUpdatedAt,
        changedAt: new Date().toISOString(),
      };
      // Version = newest of profile-row / display-icon change, so a stale reader
      // can't overwrite a fresher write (see setJsonIfNewer).
      const version = Math.max(user.updatedAt.getTime(), displayIconsUpdatedAt);
      await this.redisService?.setJsonIfNewer(
        cacheKey,
        payload,
        version,
        RealtimeService.PROFILE_SUMMARY_TTL_SECONDS,
      );
      return payload;
    });
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
    await this.redisService?.invalidateVersionedKey(
      this.badgeSnapshotCacheKey(userId),
      this.badgeSnapshotVersionKey(userId),
    );
  }

  private badgeSnapshotCacheKey(userId: string): string {
    return `${RealtimeService.HOT_CACHE_PREFIX}${userId}:badge-snapshot`;
  }

  private badgeSnapshotVersionKey(userId: string): string {
    return `${this.badgeSnapshotCacheKey(userId)}:version`;
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

    // Global-fanout psubscribe means we receive events for every user; skip
    // (and count) the ones we don't hold locally so the overhead is measurable.
    if (!this.clients.has(userId)) {
      this.crossInstanceIgnored += 1;
      return;
    }

    this.deliverLocal(userId, envelope.event);
  }

  private handleRevocationMessage(message: string) {
    const broadcast = parseSessionRevocationBroadcast(message);
    if (!broadcast) {
      this.logger.warn('Discarded malformed session-revocation broadcast.');
      return;
    }
    this.closeRevokedSockets(broadcast);
  }

  /**
   * Closes the locally-held sockets this revocation kills, and returns how many.
   *
   * Unlike realtime events there is no `origin` check: the instance that
   * processed the revocation must drop its own sockets too, and it learns about
   * them through the same subscription (Redis delivers pub/sub back to the
   * publishing process on its separate subscriber connection). One code path
   * for local and remote means one behaviour to reason about.
   */
  closeRevokedSockets(broadcast: SessionRevocationBroadcast): number {
    const revoked =
      broadcast.kind === 'user'
        ? this.socketsRevokedForUser(broadcast.userId, broadcast.revokedAtMs)
        : this.socketsRevokedForSession(broadcast.sessionId);

    for (const socket of revoked) {
      try {
        socket.close(REVOKED_CLOSE_CODE, REVOKED_CLOSE_REASON);
      } catch (error) {
        this.logger.warn(
          `Failed to close revoked socket: ${error instanceof Error ? error.message : error}`,
        );
      }
    }

    if (revoked.length > 0) {
      const target =
        broadcast.kind === 'user'
          ? `user ${broadcast.userId}`
          : `session ${broadcast.sessionId}`;
      this.logger.log(
        `Closed ${revoked.length} realtime socket(s) for revoked ${target}.`,
      );
    }
    return revoked.length;
  }

  private socketsRevokedForUser(
    userId: string,
    revokedAtMs: number,
  ): WebSocket[] {
    const group = this.clients.get(userId);
    if (!group) return [];

    return [...group].filter((socket) => {
      const issuedAtMs = this.socketIdentities.get(socket)?.issuedAtMs ?? null;
      // Mirrors `isRevoked`: the per-user stamp only kills tokens issued at or
      // before it, so a device that logged back in after a "log out everywhere"
      // keeps its socket. A token with no issuance claim is left alone for the
      // same reason HTTP leaves it alone — it still dies at its own expiry.
      return issuedAtMs !== null && issuedAtMs <= revokedAtMs;
    });
  }

  private socketsRevokedForSession(sessionId: string): WebSocket[] {
    // O(local sockets); revocations are rare next to connection churn, so a
    // second sid-keyed index isn't worth the extra state to keep consistent.
    const revoked: WebSocket[] = [];
    for (const group of this.clients.values()) {
      for (const socket of group) {
        if (this.socketIdentities.get(socket)?.sessionId === sessionId) {
          revoked.push(socket);
        }
      }
    }
    return revoked;
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
    if (!event || typeof event !== 'object') {
      return false;
    }
    const candidate = event as { type?: unknown; payload?: unknown };
    // Only known event types pass — a malformed or foreign message published to
    // the channel must never be re-broadcast to clients verbatim.
    return (
      typeof candidate.type === 'string' &&
      RealtimeService.REALTIME_EVENT_TYPES.has(candidate.type) &&
      typeof candidate.payload === 'object' &&
      candidate.payload !== null
    );
  }
}
