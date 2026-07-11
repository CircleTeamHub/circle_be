import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import type { NotificationRealtimeDto } from './notification.dto';

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const EXPO_BATCH_SIZE = 100;
const MAX_ACTIVE_TOKENS_PER_USER = 20;
const EXPO_MAX_ATTEMPTS = 3;
// Hard cap on the Expo call. sendNotification is awaited inside the
// notification-creation request path, and Node's global fetch (undici) applies
// no response timeout by default — a slow/hung Expo endpoint would otherwise
// stall the user's request (comment, friend accept, …) for minutes.
const EXPO_PUSH_TIMEOUT_MS = 8_000;
const ACTIVE_TOKEN_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
const DISABLED_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type ExpoPushTicket = {
  status?: string;
  details?: { error?: string };
};

@Injectable()
export class NotificationPushService {
  private readonly logger = new Logger(NotificationPushService.name);
  // Optional. Required only when the Expo project has "Enhanced Security for
  // Push Notifications" enabled — Expo then rejects unauthenticated sends.
  private readonly expoAccessToken: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.expoAccessToken =
      this.config.get<string>('EXPO_ACCESS_TOKEN')?.trim() ?? '';
  }

  async sendNotification(
    userId: string,
    notification: NotificationRealtimeDto,
  ): Promise<boolean> {
    const tokens = await this.prisma.devicePushToken.findMany({
      where: {
        userID: userId,
        provider: 'expo',
        disabledAt: null,
      },
      select: { token: true, projectId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
      take: MAX_ACTIVE_TOKENS_PER_USER,
    });
    if (tokens.length === 0) return true;

    const message = this.buildMessage(userId, notification);
    // Expo project IDs must not be mixed in a single request when enhanced
    // security is enabled. Group first, then batch each project independently.
    const byProject = new Map<string, typeof tokens>();
    for (const token of tokens) {
      const key = token.projectId ?? '';
      const group = byProject.get(key) ?? [];
      group.push(token);
      byProject.set(key, group);
    }
    let success = true;
    for (const projectTokens of byProject.values()) {
      for (let i = 0; i < projectTokens.length; i += EXPO_BATCH_SIZE) {
        const batch = projectTokens.slice(i, i + EXPO_BATCH_SIZE);
        success =
          (await this.sendBatch(
            batch.map((row) => ({
              to: row.token,
              sound: 'default',
              title: message.title,
              body: message.body,
              data: message.data,
            })),
          )) && success;
      }
    }
    return success;
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async deleteStaleTokens(): Promise<{ count: number }> {
    return this.prisma.$transaction(
      async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext('notification-token-cleanup')) AS acquired
      `;
        if (!lock?.acquired) return { count: 0 };

        return tx.devicePushToken.deleteMany({
          where: {
            OR: [
              {
                updatedAt: {
                  lt: new Date(Date.now() - ACTIVE_TOKEN_MAX_AGE_MS),
                },
              },
              {
                disabledAt: {
                  lt: new Date(Date.now() - DISABLED_TOKEN_MAX_AGE_MS),
                },
              },
            ],
          },
        });
      },
      { timeout: 60_000 },
    );
  }

  private buildMessage(userId: string, notification: NotificationRealtimeDto) {
    const actor = notification.fromUser?.nickname || 'CircleIM';
    const body =
      notification.type === 'TRACE_MENTION'
        ? notification.content ||
          notification.fromReply?.content ||
          this.fallbackBody(notification.type)
        : notification.content ||
          notification.fromReply?.content ||
          notification.fromCirclePost?.excerpt ||
          notification.fromTrace?.excerpt ||
          this.fallbackBody(notification.type);
    return {
      title: notification.type === 'SYSTEM' ? '系统通知' : actor,
      body,
      data: {
        notificationId: notification.id,
        type: notification.type,
        toUserId: userId,
        ...(notification.fromUser
          ? {
              fromUserId: notification.fromUser.id,
              fromUserNickname: notification.fromUser.nickname,
            }
          : {}),
        ...(notification.type === 'SYSTEM' ? { route: 'system' } : {}),
        ...(notification.fromTrace?.id
          ? { traceId: notification.fromTrace.id }
          : {}),
        ...(notification.fromReply?.id
          ? { replyId: notification.fromReply.id }
          : {}),
        ...(notification.fromCirclePost?.id
          ? { postId: notification.fromCirclePost.id }
          : {}),
        ...(notification.fromInvitation?.id
          ? { invitationId: notification.fromInvitation.id }
          : {}),
        ...(notification.requestId
          ? { requestId: notification.requestId }
          : {}),
      },
    };
  }

  private fallbackBody(type: string): string {
    if (type === 'TRACE_LIKE') return '点赞了你的动态';
    if (type === 'TRACE_COMMENT') return '评论了你的动态';
    if (type === 'COMMENT_REPLY') return '回复了你的评论';
    if (type === 'TRACE_MENTION') return '在动态评论中提到了你';
    if (type === 'FRIEND_REQUEST_RECEIVED') return '请求添加你为好友';
    if (type === 'FRIEND_REQUEST_ACCEPTED') return '已通过你的好友申请';
    if (type === 'FRIEND_REQUEST_REJECTED') return '已拒绝你的好友申请';
    if (type === 'PROFILE_LIKE') return '赞了你的资料';
    if (type === 'CIRCLE_VERIFICATION_REQUESTED') return '邀请你验证入圈申请';
    if (type === 'CIRCLE_POST_PUBLISHED') return '在圈子发布了新活动';
    if (type === 'CIRCLE_POST_SIGNUP_CREATED') return '报名了你的帖子';
    if (type === 'CIRCLE_POST_AUTO_ENDED') return '你的帖子报名已结束';
    if (type === 'CIRCLE_POST_COLLABORATION_RECOGNIZED')
      return '认可了你的活动协作';
    return '你有一条新通知';
  }

  private async sendBatch(
    messages: Array<Record<string, unknown>>,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= EXPO_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.expoAccessToken
              ? { Authorization: `Bearer ${this.expoAccessToken}` }
              : {}),
          },
          body: JSON.stringify(messages),
          signal: AbortSignal.timeout(EXPO_PUSH_TIMEOUT_MS),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const payload = (await response.json()) as { data?: ExpoPushTicket[] };
        await this.disableUnregisteredTokens(messages, payload.data ?? []);
        return true;
      } catch (error) {
        if (attempt === EXPO_MAX_ATTEMPTS) {
          this.logger.warn(
            `Expo push send failed after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}`,
          );
          return false;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, 250 * 2 ** (attempt - 1)),
        );
      }
    }
    return false;
  }

  private async disableUnregisteredTokens(
    messages: Array<Record<string, unknown>>,
    tickets: ExpoPushTicket[],
  ) {
    const badTokens = tickets
      .map((ticket, index) =>
        ticket.status === 'error' &&
        ticket.details?.error === 'DeviceNotRegistered'
          ? messages[index]?.to
          : null,
      )
      .filter((token): token is string => typeof token === 'string');
    if (badTokens.length === 0) return;

    await this.prisma.devicePushToken.updateMany({
      where: { token: { in: badTokens } },
      data: { disabledAt: new Date() },
    });
  }
}
