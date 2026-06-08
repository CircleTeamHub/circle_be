import { Injectable, Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  DISCOVER_NOTIFICATION_TYPES,
  PROFILE_NOTIFICATION_TYPES,
} from 'src/notification/notification.constants';

type BadgeSnapshot = {
  messagesUnread: number;
  contactsUnread: number;
  discoverUnread: number;
  signupUnread: number;
  profileUnread: number;
  systemUnread: number;
  syncedAt: string;
};

type RealtimeEvent =
  | { type: 'badge.snapshot'; payload: BadgeSnapshot }
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
      payload: {
        vipLevel: number;
        expiredAt: string | null;
        changedAt: string;
      };
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
      type: 'system.notification.created';
      payload: {
        content: string;
        changedAt: string;
      };
    }
  | {
      type: 'user.profile.summary.changed';
      payload: {
        vipLevel: number;
        creditScore: number;
        displayIconsVersion: number;
        changedAt: string;
      };
    };

@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly clients = new Map<string, Set<WebSocket>>();

  constructor(private readonly prisma: PrismaService) {}

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

    return {
      messagesUnread: 0,
      contactsUnread,
      discoverUnread,
      signupUnread,
      profileUnread,
      systemUnread: profileUnread,
      syncedAt: new Date().toISOString(),
    };
  }

  async emitSnapshot(userId: string) {
    const snapshot = await this.buildSnapshot(userId);
    this.broadcast(userId, {
      type: 'badge.snapshot',
      payload: snapshot,
    });
  }

  async broadcastFriendUnreadCount(userId: string) {
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
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { vipLevel: true },
    });
    if (!user) {
      return;
    }

    this.broadcast(userId, {
      type: 'membership.status.changed',
      payload: {
        vipLevel: user.vipLevel,
        expiredAt: null,
        changedAt: new Date().toISOString(),
      },
    });
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
      return;
    }

    this.broadcast(userId, {
      type: 'user.profile.summary.changed',
      payload: {
        vipLevel: user.vipLevel,
        creditScore: user.creditScore,
        displayIconsVersion:
          latestDisplayIcon?.updatedAt.getTime() ?? Date.now(),
        changedAt: new Date().toISOString(),
      },
    });
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
}
