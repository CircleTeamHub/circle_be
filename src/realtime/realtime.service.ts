import { Injectable } from '@nestjs/common';
import { NotificationType } from 'src/generated/prisma';
import { WebSocket } from 'ws';
import { PrismaService } from 'src/prisma/prisma.service';

type BadgeSnapshot = {
  messagesUnread: number;
  contactsUnread: number;
  discoverUnread: number;
  profileUnread: number;
  systemUnread: number;
  syncedAt: string;
};

type RealtimeEvent =
  | { type: 'badge.snapshot'; payload: BadgeSnapshot }
  | {
      type:
        | 'friend.activity.unread.changed'
        | 'circle.activity.unread.changed'
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
        balance: number;
        delta: number | null;
        reason: string;
        changedAt: string;
      };
    }
  | {
      type: 'wallet.recharge.completed';
      payload: {
        balance: number;
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

const DISCOVER_NOTIFICATION_TYPES = [
  NotificationType.TRACE_COMMENT,
  NotificationType.COMMENT_REPLY,
] as const;

const PROFILE_NOTIFICATION_TYPES = [NotificationType.SYSTEM] as const;

@Injectable()
export class RealtimeService {
  private readonly clients = new Map<string, Set<WebSocket>>();

  constructor(private readonly prisma: PrismaService) {}

  registerClient(userId: string, socket: WebSocket) {
    const group = this.clients.get(userId) ?? new Set<WebSocket>();
    group.add(socket);
    this.clients.set(userId, group);
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
    const [contactsUnread, circleUnread, discoverNotificationUnread, profileUnread] = await Promise.all([
      this.prisma.friendActivity.count({
        where: { viewerId: userId, readAt: null },
      }),
      this.prisma.circleActivity.count({
        where: { viewerID: userId, readAt: null },
      }),
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
      messagesUnread: 0,
      contactsUnread,
      discoverUnread: circleUnread + discoverNotificationUnread,
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

  async broadcastCircleUnreadCount(userId: string) {
    const [circleUnread, discoverNotificationUnread] = await Promise.all([
      this.prisma.circleActivity.count({
        where: { viewerID: userId, readAt: null },
      }),
      this.prisma.notification.count({
        where: {
          toUserID: userId,
          deleted: false,
          read: false,
          type: { in: [...DISCOVER_NOTIFICATION_TYPES] },
        },
      }),
    ]);

    this.broadcast(userId, {
      type: 'circle.activity.unread.changed',
      payload: {
        count: circleUnread + discoverNotificationUnread,
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

  async broadcastWalletBalanceChanged(
    userId: string,
    payload?: { reason?: string; delta?: number | null },
  ) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userID: userId },
      select: { balance: true },
    });
    if (!wallet) {
      return;
    }

    this.broadcast(userId, {
      type: 'wallet.balance.changed',
      payload: {
        balance: wallet.balance,
        delta: payload?.delta ?? null,
        reason: payload?.reason ?? 'UNKNOWN',
        changedAt: new Date().toISOString(),
      },
    });
  }

  async broadcastWalletRechargeCompleted(userId: string, amount: number) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userID: userId },
      select: { balance: true },
    });
    if (!wallet) {
      return;
    }

    this.broadcast(userId, {
      type: 'wallet.recharge.completed',
      payload: {
        balance: wallet.balance,
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

  broadcast(userId: string, event: RealtimeEvent) {
    const group = this.clients.get(userId);
    if (!group || group.size === 0) {
      return;
    }

    const message = JSON.stringify(event);

    for (const socket of group) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(message);
      }
    }
  }
}
