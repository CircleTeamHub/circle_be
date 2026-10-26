import { GIFT_CARD_MAX_ATTEMPTS } from 'src/coin/gift-card-outbox.processor';
import { VERIFICATION_CARD_MAX_ATTEMPTS } from 'src/circle-invitation/circle-invitation.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  runAdminOperation,
  writeOperationAudit,
} from 'src/admin-operations/admin-operation-request';
import { OUTBOX_QUEUES } from 'src/metrics/outbox-depth.service';
import {
  ADMIN_FANOUT_MAX_CONCURRENT_QUERIES,
  createConcurrencyLimiter,
} from 'src/utils/concurrency-limit';
import { diagnosticCategory } from './console-policy';
import type {
  ConsoleQuery,
  PushSendDto,
  PushSettingsDto,
  RetryDto,
} from './console.dto';

export function pageCursor(cursor?: string) {
  if (!cursor) return undefined;
  const [time, id] = cursor.split('|');
  const createdAt = new Date(time);
  if (
    !Number.isFinite(createdAt.getTime()) ||
    !/^(?:[a-f0-9-]{36}|[a-f0-9]{64})$/i.test(id ?? '')
  )
    throw new BadRequestException('分页游标无效');
  return { createdAt, id };
}
export function olderThan(cursor?: string) {
  const row = pageCursor(cursor);
  return row
    ? {
        OR: [
          { createdAt: { lt: row.createdAt } },
          { createdAt: row.createdAt, id: { lt: row.id } },
        ],
      }
    : {};
}
export function paged<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
) {
  const items = rows.slice(0, limit),
    last = items[items.length - 1];
  return {
    items,
    nextCursor:
      rows.length > limit && last
        ? `${last.createdAt.toISOString()}|${last.id}`
        : null,
  };
}
const QUEUES = {
  notification_push: 'NotificationPushOutbox',
  group_operation: 'AdminGroupOperation',
  chat_direct_auto_reply: 'ChatDirectAutoReplyJob',
  chat_support_recharge: 'SupportRechargeJob',
  friend_chat_replay: 'FriendChatReplayOutbox',
} as const;

@Injectable()
export class ConsoleOperationsService {
  /**
   * 任务总览一次约 20 条查询(每个队列 pending 聚合 + 死信计数,再加群操作统计)。
   * 以前全部同时打到 10 个连接的池上;现在整个实例最多占 3 个,理由同
   * OUTBOX_PROBE_MAX_CONCURRENT_QUERIES 的注释。
   *
   * 不直接读 OutboxDepthService 的每分钟样本:口径不一致 —— 样本没有死信态的
   * 队列记 0(这里回 null)、只有最老待办的秒数(这里回时刻)、最多陈旧 60 秒,
   * 也不含群操作统计。
   */
  private readonly limitQueries = createConcurrencyLimiter(
    ADMIN_FANOUT_MAX_CONCURRENT_QUERIES,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async taskOverview() {
    const now = new Date();
    const limit = this.limitQueries;
    const source = this.prisma as unknown as Record<
      string,
      {
        aggregate: (arg: unknown) => Promise<{
          _count: { _all: number };
          _min: Record<string, Date | null>;
        }>;
        count: (arg: unknown) => Promise<number>;
      }
    >;
    const items = await Promise.all(
      OUTBOX_QUEUES.map(async (queue) => {
        // 与 collectOutboxDepths 同一口径:随时间变化的 pendingWhere(access_revocation)
        // 先求值 —— 原样把函数交给 Prisma 会被拒绝序列化,整个总览接口 500;最老待办按
        // 队列声明的列算。
        const oldestField = queue.oldestField ?? 'createdAt';
        const pendingWhere =
          typeof queue.pendingWhere === 'function'
            ? queue.pendingWhere(now)
            : queue.pendingWhere;
        const [pending, dead] = await Promise.all([
          limit(() =>
            source[queue.model].aggregate({
              where: pendingWhere,
              _count: { _all: true },
              _min: { [oldestField]: true },
            }),
          ),
          queue.deadWhere
            ? limit(() => source[queue.model].count({ where: queue.deadWhere }))
            : Promise.resolve(null),
        ]);
        return {
          kind: queue.name,
          pending: pending._count._all,
          dead,
          oldestAt: pending._min[oldestField] ?? null,
        };
      }),
    );
    const group = await limit(() =>
      this.prisma.adminGroupOperation.groupBy({
        by: ['status'],
        _count: true,
      }),
    );
    return { generatedAt: new Date(), items, groupOperations: group };
  }

  async tasks(query: ConsoleQuery) {
    const kind = query.kind ?? 'notification_push';
    let source: Prisma.Sql;
    if (Object.prototype.hasOwnProperty.call(QUEUES, kind)) {
      const table = Prisma.raw(`"${QUEUES[kind as keyof typeof QUEUES]}"`);
      source = Prisma.sql`SELECT id,status::text,attempts,"nextAttemptAt","lastError","createdAt","updatedAt" FROM ${table}`;
    } else if (kind === 'session_revocation') {
      source = Prisma.sql`SELECT "userID" AS id,'PENDING'::text AS status,attempts,"nextAttemptAt","lastError","createdAt","updatedAt" FROM "SessionRevocationOutbox"`;
    } else if (kind === 'gift_card') {
      source = Prisma.sql`SELECT id,CASE WHEN "cardDeliveredAt" IS NOT NULL THEN 'COMPLETED' WHEN "cardAttempts">=${GIFT_CARD_MAX_ATTEMPTS} THEN 'TERMINAL' ELSE 'PENDING' END AS status,"cardAttempts" AS attempts,NULL::timestamp AS "nextAttemptAt",NULL::text AS "lastError","createdAt",COALESCE("cardDeliveredAt","createdAt") AS "updatedAt" FROM "CoinGift"`;
    } else if (kind === 'verification_card') {
      source = Prisma.sql`SELECT v.id,CASE WHEN v."cardDeliveredAt" IS NOT NULL THEN 'COMPLETED' WHEN v."cardAttempts">=${VERIFICATION_CARD_MAX_ATTEMPTS} OR v.status<>'PENDING' OR i.status<>'PENDING' THEN 'TERMINAL' ELSE 'PENDING' END AS status,v."cardAttempts" AS attempts,NULL::timestamp AS "nextAttemptAt",NULL::text AS "lastError",v."createdAt",COALESCE(v."cardDeliveredAt",v."createdAt") AS "updatedAt" FROM "CircleInvitationVerifier" v JOIN "CircleInvitation" i ON i.id=v."invitationID"`;
    } else throw new BadRequestException('未知队列');
    const cursor = pageCursor(query.cursor);
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        status: string;
        attempts: number;
        nextAttemptAt: Date;
        lastError: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >(Prisma.sql`
      SELECT * FROM (${source}) AS tasks
      WHERE (${query.status ?? null}::text IS NULL OR status::text = ${query.status ?? null})
      ${cursor ? Prisma.sql`AND ("createdAt",id) < (${cursor.createdAt},${cursor.id})` : Prisma.empty}
      ORDER BY "createdAt" DESC,id DESC LIMIT ${query.limit + 1}
    `);
    // Enrich only the visible page. Select public account labels and aggregate
    // delivery states without returning notification bodies, payloads or tokens.
    const ids = rows.slice(0, query.limit).map((row) => row.id);
    const [notifications, deliveries] =
      kind === 'notification_push' && ids.length
        ? await Promise.all([
            this.prisma.notificationPushOutbox.findMany({
              where: { id: { in: ids } },
              select: {
                id: true,
                completionReason: true,
                notification: {
                  select: {
                    type: true,
                    toUserID: true,
                    toUser: { select: { id: true, nickname: true } },
                  },
                },
              },
            }),
            this.prisma.notificationPushDelivery.groupBy({
              by: ['outboxID', 'status'],
              where: { outboxID: { in: ids } },
              _count: { _all: true },
            }),
          ])
        : [[], []];
    const notificationByID = new Map(
      notifications.map((item) => [item.id, item.notification]),
    );
    const reasonByID = new Map(
      notifications.map((item) => [item.id, item.completionReason]),
    );
    const deliveryByID = new Map<string, Record<string, number>>();
    for (const delivery of deliveries) {
      const counts = deliveryByID.get(delivery.outboxID) ?? {};
      counts[delivery.status] = delivery._count._all;
      deliveryByID.set(delivery.outboxID, counts);
    }
    return {
      ...paged(
        rows.map((row) => ({
          ...row,
          nextAttemptAt: ['COMPLETED', 'TERMINAL'].includes(row.status)
            ? null
            : row.nextAttemptAt,
          ...(kind === 'notification_push'
            ? {
                notification: notificationByID.get(row.id) ?? null,
                completionReason: reasonByID.get(row.id) ?? null,
                deliveryCounts: deliveryByID.get(row.id) ?? {},
              }
            : {}),
          lastError: diagnosticCategory(row.lastError),
          retryable: kind === 'notification_push' && row.status === 'FAILED',
        })),
        query.limit,
      ),
      kind,
    };
  }

  retryPush(actorID: string, id: string, dto: RetryDto, key?: string) {
    return runAdminOperation(
      this.prisma,
      actorID,
      'push.retry',
      key,
      { id, ...dto },
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{ status: string; updatedAt: Date }>
        >`SELECT status,"updatedAt" FROM "NotificationPushOutbox" WHERE id=${id} FOR UPDATE`;
        const row = rows[0];
        if (!row) throw new NotFoundException('未找到推送任务');
        if (
          row.status !== 'FAILED' ||
          row.updatedAt.toISOString() !== dto.version
        )
          throw new ConflictException('任务状态已变化或不允许重试，请刷新');
        await tx.notificationPushDelivery.updateMany({
          where: { outboxID: id, status: 'FAILED' },
          data: { attempts: 0 },
        });
        await tx.notificationPushOutbox.update({
          where: { id },
          data: {
            status: 'PENDING',
            attempts: 0,
            nextAttemptAt: new Date(),
            lockedAt: null,
            leaseToken: null,
            lastError: null,
          },
        });
        await writeOperationAudit(
          tx,
          actorID,
          'console.push.retry',
          'push_task',
          id,
          dto.reason,
          { status: row.status },
          { status: 'PENDING' },
        );
        return { id, status: 'PENDING' };
      },
    );
  }

  async pushOverview() {
    const [settings, counts] = await Promise.all([
      this.prisma.consolePushSettings.findUniqueOrThrow({
        where: { id: 'global' },
      }),
      this.prisma.notificationPushOutbox.groupBy({
        by: ['status'],
        where: { createdAt: { gte: new Date(Date.now() - 86400_000) } },
        _count: true,
      }),
    ]);
    return {
      settings,
      counts,
      providers: [
        { name: 'expo', configured: true },
        {
          name: 'jpush',
          configured:
            !!this.config.get('JPUSH_APP_KEY') &&
            !!this.config.get('JPUSH_MASTER_SECRET'),
        },
      ],
      receiptMeaning:
        '渠道已接受表示推送服务已接收发送请求；回执已记录表示系统已记录渠道确认或超时处理结果，均不代表用户已收到或已读',
    };
  }

  async pushes(query: ConsoleQuery) {
    const device = query.deviceID
      ? await this.prisma.devicePushToken.findUnique({
          where: { id: query.deviceID },
          select: { token: true },
        })
      : null;
    if (query.deviceID && !device)
      throw new NotFoundException('设备登记不存在或已清理');

    const rows = await this.prisma.notificationPushOutbox.findMany({
      where: {
        ...olderThan(query.cursor),
        ...(query.taskID ? { id: query.taskID } : {}),
        ...(device ? { deliveries: { some: { token: device.token } } } : {}),
        ...(query.userID ? { notification: { toUserID: query.userID } } : {}),
        ...(query.status ? { status: query.status as never } : {}),
      },
      select: {
        id: true,
        status: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
        nextAttemptAt: true,
        completionReason: true,
        notification: {
          select: {
            toUserID: true,
            type: true,
            toUser: { select: { id: true, nickname: true } },
          },
        },
        deliveries: {
          take: 100,
          orderBy: { id: 'asc' },
          select: {
            id: true,
            status: true,
            attempts: true,
            sentAt: true,
            receiptCheckedAt: true,
            lastError: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const deviceRows = rows.length
      ? await this.prisma.$queryRaw<
          Array<{
            id: string;
            deviceID: string | null;
            provider: string | null;
            platform: string | null;
          }>
        >(
          Prisma.sql`SELECT d.id,t.id AS "deviceID",t.provider,t.platform FROM "NotificationPushDelivery" d LEFT JOIN "DevicePushToken" t ON t.token=d.token WHERE d."outboxID" IN (${Prisma.join(rows.map((r) => r.id))}) ORDER BY d.id LIMIT 10000`,
        )
      : [];
    const deliveryTotals = rows.length
      ? await this.prisma.notificationPushDelivery.groupBy({
          by: ['outboxID', 'status'],
          where: { outboxID: { in: rows.map((row) => row.id) } },
          _count: { _all: true },
        })
      : [];
    const counts = new Map<string, Record<string, number>>();
    for (const delivery of deliveryTotals) {
      const totals = counts.get(delivery.outboxID) ?? {};
      totals[delivery.status] = delivery._count._all;
      counts.set(delivery.outboxID, totals);
    }
    const deviceMap = new Map(deviceRows.map((r) => [r.id, r]));
    return paged(
      rows.map((row) => ({
        ...row,
        deliveryCounts: counts.get(row.id) ?? {},
        lastError: diagnosticCategory(row.lastError),
        deliveries: row.deliveries.map((d) => ({
          ...d,
          deviceID: deviceMap.get(d.id)?.deviceID ?? null,
          provider: deviceMap.get(d.id)?.provider ?? null,
          platform: deviceMap.get(d.id)?.platform ?? null,
          lastError: diagnosticCategory(d.lastError),
        })),
      })),
      query.limit,
    );
  }

  async devices(userID: string) {
    return {
      items: await this.prisma.devicePushToken.findMany({
        where: { userID },
        select: {
          id: true,
          provider: true,
          platform: true,
          appVersion: true,
          disabledAt: true,
          updatedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    };
  }

  settings(actorID: string, dto: PushSettingsDto, key?: string) {
    return runAdminOperation(
      this.prisma,
      actorID,
      'push.settings',
      key,
      dto,
      async (tx) => {
        const result = await tx.consolePushSettings.updateMany({
          where: { id: 'global', version: dto.version },
          data: { enabled: dto.enabled, version: { increment: 1 } },
        });
        if (!result.count) throw new ConflictException('配置已变化，请刷新');
        await writeOperationAudit(
          tx,
          actorID,
          'console.push.settings',
          'push_settings',
          'global',
          dto.reason,
          undefined,
          { enabled: dto.enabled },
        );
        return tx.consolePushSettings.findUniqueOrThrow({
          where: { id: 'global' },
        });
      },
    );
  }

  send(actorID: string, dto: PushSendDto, key?: string) {
    return runAdminOperation(
      this.prisma,
      actorID,
      'push.targeted',
      key,
      dto,
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('system-announcement-scrolling'))::text`;
        const announcement = await tx.systemAnnouncement.findUnique({
          where: { id: dto.announcementID, deletedAt: null },
          select: { id: true, content: true },
        });
        if (!announcement)
          throw new NotFoundException('请选择已发布的系统公告');
        const recipients = [...dto.recipients].sort((a, b) =>
          a.localeCompare(b),
        );
        const active = await tx.user.count({
          where: { id: { in: recipients }, status: 'ACTIVE' },
        });
        if (active !== recipients.length)
          throw new BadRequestException('包含不存在或不可用的收件人');
        // Existing notification/outbox uniqueness prevents duplicating an announcement for a recipient.
        let queued = 0;
        for (const userID of recipients) {
          const existing = await tx.notification.findUnique({
            where: {
              systemAnnouncementID_toUserID: {
                systemAnnouncementID: announcement.id,
                toUserID: userID,
              },
            },
            select: { id: true },
          });
          if (existing) continue;
          await tx.notification.create({
            data: {
              toUserID: userID,
              fromUserID: userID,
              type: 'SYSTEM',
              content: announcement.content,
              systemAnnouncementID: announcement.id,
              pushOutbox: { create: {} },
            },
          });
          queued++;
        }
        await writeOperationAudit(
          tx,
          actorID,
          'console.push.targeted',
          'announcement',
          announcement.id,
          dto.reason,
          undefined,
          { requested: recipients.length, queued },
        );
        return {
          requested: recipients.length,
          queued,
          existing: recipients.length - queued,
        };
      },
    );
  }

  async announcements() {
    return {
      items: await this.prisma.systemAnnouncement.findMany({
        where: { deletedAt: null },
        select: { id: true, content: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    };
  }
}
