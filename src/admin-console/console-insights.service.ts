import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import { RedisService } from 'src/redis/redis.service';
import { JobLeaseContext, runWithJobLease } from 'src/redis/job-lease';
import { createHash } from 'crypto';
import { CronExpression } from '@nestjs/schedule';
import {
  reportJobSkipped,
  TrackedCron,
} from 'src/metrics/tracked-cron.decorator';
import { olderThan, paged } from './console-operations.service';
import { FAILED_AUDIT_WHERE } from 'src/admin-operations/audit-record-kind';
import { diagnosticContext } from './diagnostic-context';
import type { AppOpenDto, ConsoleQuery, DiagnosticQuery } from './console.dto';

const EVENT_RETENTION_JOB = 'console_event_retention';
const EVENT_RETENTION_DAYS = 180;
const EVENT_RETENTION_BATCH = 5_000;
const EVENT_RETENTION_BUDGET_MS = 5 * 60_000;
const EVENT_RETENTION_PAUSE_MS = 100;
const INSIGHT_TTL_MS = 45_000;
const INSIGHT_FAILURE_TTL_MS = 30_000;

@Injectable()
export class ConsoleInsightsService {
  private readonly logger = new Logger(ConsoleInsightsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async appOpen(
    userID: string,
    device: string | undefined,
    dto: AppOpenDto,
    sessionID?: string,
  ) {
    if (!device || device.length < 16 || device.length > 200)
      throw new BadRequestException('需要有效设备标识');
    const deviceKey = createHash('sha256').update(device).digest('hex');
    const session = sessionID
      ? await this.prisma.refreshToken.findUnique({
          where: { id: sessionID },
          select: {
            userId: true,
            audience: true,
            deviceKey: true,
            revokedAt: true,
            expiredAt: true,
          },
        })
      : null;
    if (
      !session ||
      session.userId !== userID ||
      session.audience !== 'APP' ||
      session.deviceKey !== deviceKey ||
      session.revokedAt ||
      session.expiredAt <= new Date()
    )
      throw new BadRequestException('需要当前设备绑定的 App 会话');
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "User" WHERE id=${userID} FOR UPDATE`;
      const previous = await tx.appInstallation.findUnique({
        where: { userID_deviceKey: { userID, deviceKey } },
        select: { lastSeenAt: true },
      });
      if (
        !previous &&
        (await tx.appInstallation.count({ where: { userID } })) >= 64
      )
        throw new BadRequestException('设备登记数量已达上限');
      await tx.appInstallation.upsert({
        where: { userID_deviceKey: { userID, deviceKey } },
        create: {
          userID,
          deviceKey,
          platform: dto.platform,
          appVersion: dto.appVersion,
          build: dto.build,
          channel: dto.channel,
        },
        update: {
          platform: dto.platform,
          appVersion: dto.appVersion,
          build: dto.build,
          channel: dto.channel,
          lastSeenAt: new Date(),
        },
      });
      // Authenticated callers cannot manufacture unbounded activity or installation rows.
      if (
        await tx.consoleEvent.findFirst({
          where: {
            userID,
            name: 'APP_OPEN',
            createdAt: {
              gte: new Date(Math.floor(Date.now() / 300000) * 300000),
            },
          },
          select: { id: true },
        })
      )
        return { recorded: true };
      // IDs are bound to the account; retries neither overwrite another event nor count twice.
      const id = createHash('sha256')
        .update(`${userID}:${dto.eventID}`)
        .digest('hex');
      await tx.consoleEvent.upsert({
        where: { id },
        create: {
          id,
          userID,
          name: 'APP_OPEN',
          source: 'APP',
          platform: dto.platform,
          appVersion: dto.appVersion,
        },
        update: {},
      });
      return { recorded: true };
    });
  }

  async timeline(userID: string, query: ConsoleQuery) {
    if (
      !(await this.prisma.user.findUnique({
        where: { id: userID },
        select: { id: true },
      }))
    )
      throw new NotFoundException('用户不存在');
    const rows = await this.prisma.consoleEvent.findMany({
      where: {
        userID,
        ...olderThan(query.cursor),
        ...(query.name ? { name: query.name } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const [sessions, devices, installation] = query.cursor
      ? [[], [], []]
      : await Promise.all([
          this.prisma.refreshToken.findMany({
            where: { userId: userID },
            select: {
              id: true,
              audience: true,
              deviceName: true,
              createdAt: true,
              lastUsedAt: true,
              revokedAt: true,
              expiredAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 20,
          }),
          this.prisma.trustedDevice.findMany({
            where: { userId: userID },
            select: {
              id: true,
              deviceName: true,
              lastSeenAt: true,
              revokedAt: true,
            },
            orderBy: { lastSeenAt: 'desc' },
            take: 20,
          }),
          this.prisma.appInstallation.findMany({
            where: { userID },
            select: {
              id: true,
              platform: true,
              appVersion: true,
              build: true,
              channel: true,
              lastSeenAt: true,
            },
            orderBy: { lastSeenAt: 'desc' },
            take: 20,
          }),
        ]);
    return {
      ...paged(rows, query.limit),
      sessions,
      devices,
      installations: installation,
      collectionStartedAt: (
        await this.prisma.consoleCollectionState.findUniqueOrThrow({
          where: { id: 'global' },
        })
      ).startedAt,
    };
  }

  // 失败也进缓存(短一些):超时多半是库忙,窗口内重复刷新只会继续加压。
  private readonly insightCache = new Map<
    number,
    { expiresAt: number } & (
      | {
          data: Awaited<ReturnType<ConsoleInsightsService['computeAnalytics']>>;
        }
      | { error: unknown }
    )
  >();
  private readonly insightReads = new Map<
    number,
    Promise<Awaited<ReturnType<ConsoleInsightsService['computeAnalytics']>>>
  >();
  // 全局只算一个窗口:不同 days 排在这条链后面,看板最多占一个池连接。
  private insightQueue: Promise<unknown> = Promise.resolve();
  analytics(days: number) {
    const cached = this.insightCache.get(days);
    if (cached && cached.expiresAt > Date.now())
      return 'data' in cached
        ? Promise.resolve(cached.data)
        : Promise.reject(cached.error);
    const pending = this.insightReads.get(days);
    if (pending) return pending;
    const read = this.insightQueue
      .then(() => this.computeAnalytics(days))
      .then(
        (data) => {
          this.insightCache.set(days, {
            expiresAt: Date.now() + INSIGHT_TTL_MS,
            data,
          });
          return data;
        },
        (error: unknown) => {
          this.insightCache.set(days, {
            expiresAt: Date.now() + INSIGHT_FAILURE_TTL_MS,
            error,
          });
          throw error;
        },
      )
      .finally(() => this.insightReads.delete(days));
    this.insightQueue = read.catch(() => undefined);
    this.insightReads.set(days, read);
    return read;
  }
  private async computeAnalytics(days: number) {
    const first = await this.prisma.consoleCollectionState.findUniqueOrThrow({
      where: { id: 'global' },
    });
    const since = new Date(
      Math.max(Date.now() - days * 86400_000, first.startedAt.getTime()),
    );
    // 四条全窗口聚合依次跑:同时发一次占 4 个池连接(池默认 10),会挤掉业务请求。
    const daily = await this.prisma.$queryRaw<
      Array<{ day: string; users: number; events: number }>
    >(Prisma.sql`
        SELECT to_char("createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS "day", COUNT(DISTINCT "userID")::int users, COUNT(*)::int events
        FROM "ConsoleEvent" WHERE "createdAt">=${since} AND name IN ('APP_OPEN','MESSAGE_SENT','NOTE_CREATED','POST_CREATED','REPORT_CREATED') GROUP BY 1 ORDER BY 1`);
    const features = await this.prisma.$queryRaw<
      Array<{ name: string; source: string; users: number; events: number }>
    >(Prisma.sql`
        SELECT name,source,COUNT(DISTINCT "userID")::int users,COUNT(*)::int events FROM "ConsoleEvent" WHERE "createdAt">=${since} GROUP BY name,source ORDER BY events DESC LIMIT 50`);
    const retention = await this.prisma.$queryRaw<
      Array<{ day: number; eligible: number; returned: number }>
    >(Prisma.sql`
        SELECT d."day",COUNT(*) FILTER (WHERE (u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date + d."day" < (now() AT TIME ZONE 'Asia/Shanghai')::date)::int eligible,
          COUNT(*) FILTER (WHERE (u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date + d."day" < (now() AT TIME ZONE 'Asia/Shanghai')::date AND EXISTS (
            SELECT 1 FROM "ConsoleEvent" e WHERE e."userID"=u.id AND e.name IN ('APP_OPEN','MESSAGE_SENT','NOTE_CREATED','POST_CREATED','REPORT_CREATED')
              AND e."createdAt">=(((u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date+d."day")::timestamp AT TIME ZONE 'Asia/Shanghai' AT TIME ZONE 'UTC')
              AND e."createdAt"<(((u."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date+d."day"+1)::timestamp AT TIME ZONE 'Asia/Shanghai' AT TIME ZONE 'UTC')
          ))::int returned
        FROM "User" u CROSS JOIN (VALUES(1),(7),(30)) d("day") WHERE u."createdAt">=${since} GROUP BY d."day" ORDER BY d."day"`);
    const funnel = await this.prisma.$queryRaw<
      Array<{
        registered: number;
        opened: number;
        joined: number;
        messaged: number;
      }>
    >(Prisma.sql`
        SELECT COUNT(*)::int registered,COUNT(o."at")::int opened,COUNT(g."at")::int joined,COUNT(m."at")::int messaged FROM "User" u
        LEFT JOIN LATERAL (SELECT MIN("createdAt") AS "at" FROM "ConsoleEvent" WHERE "userID"=u.id AND name='APP_OPEN' AND "createdAt">=u."createdAt" AND "createdAt"<u."createdAt"+interval '7 days') o ON true
        LEFT JOIN LATERAL (SELECT MIN("createdAt") AS "at" FROM "ConsoleEvent" WHERE "userID"=u.id AND name='GROUP_JOINED' AND "createdAt">=o."at" AND "createdAt"<u."createdAt"+interval '7 days') g ON true
        LEFT JOIN LATERAL (SELECT MIN("createdAt") AS "at" FROM "ConsoleEvent" WHERE "userID"=u.id AND name='MESSAGE_SENT' AND "createdAt">=g."at" AND "createdAt"<u."createdAt"+interval '7 days') m ON true
        WHERE u."createdAt">=${since}`);
    return {
      generatedAt: new Date(),
      timezone: 'Asia/Shanghai',
      days,
      collectionStartedAt: first.startedAt,
      daily,
      features,
      retention,
      funnel: funnel[0],
      definitions: {
        active:
          '所选自然日内 App 活跃、发消息、创建笔记、发布动态或主动举报的去重账号；被动通知与后台状态变化不计活跃',
        retention: '注册后的第 N 个自然日发生行为；目标自然日未结束不进入分母',
        funnel:
          '注册 → App 活跃 → 加入圈子 → 发消息，严格按顺序且注册后 7 天内',
        coverage: '历史埋点不回填；采集开始前的留存与漏斗无法还原',
        merge:
          '发消息按每人每 5 分钟合并为一条（与 App 活跃同口径），会话只记新登录、续签不计；事件数是活跃时段数而非消息条数',
      },
    };
  }

  async events(query: ConsoleQuery) {
    return paged(
      await this.prisma.consoleEvent.findMany({
        where: {
          ...olderThan(query.cursor),
          ...(query.userID ? { userID: query.userID } : {}),
          ...(query.name ? { name: query.name } : {}),
        },
        include: {
          user: { select: { id: true, nickname: true, accountId: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      query.limit,
    );
  }

  async diagnostics(query: DiagnosticQuery) {
    const page = paged(
      await this.prisma.adminAuditLog.findMany({
        where: {
          AND: [FAILED_AUDIT_WHERE],
          ...olderThan(query.cursor),
          ...(query.requestID ? { requestId: query.requestID } : {}),
          ...(query.userID ? { actorID: query.userID } : {}),
        },
        select: {
          id: true,
          actorID: true,
          actorAccountId: true,
          action: true,
          entityType: true,
          entityID: true,
          reason: true,
          requestId: true,
          createdAt: true,
          metadata: true,
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
      query.limit,
    );
    const actors = page.items.length
      ? await this.prisma.user.findMany({
          where: {
            id: { in: [...new Set(page.items.map((row) => row.actorID))] },
          },
          select: { id: true, nickname: true, accountId: true },
        })
      : [];
    const people = new Map(actors.map((actor) => [actor.id, actor]));
    return {
      ...page,
      items: page.items.map(({ metadata, ...row }) => {
        const status =
          metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? metadata.status
            : undefined;
        return {
          ...row,
          actor: people.get(row.actorID) ?? null,
          ...(row.action === 'console.request.failed'
            ? diagnosticContext(metadata)
            : { requestMethod: null, requestRoute: null, failureCause: null }),
          // Expose an allowlisted context only; never return raw metadata or exception text.
          failureStatus:
            row.action === 'console.request.failed' &&
            typeof status === 'number' &&
            Number.isInteger(status) &&
            status >= 400 &&
            status <= 599
              ? status
              : null,
        };
      }),
    };
  }

  @TrackedCron(CronExpression.EVERY_DAY_AT_4AM, 'console_event_retention')
  async cleanEvents(): Promise<number> {
    // 多实例只让持有租约的那个删;SKIP LOCKED 兜住 Redis 不可用时的照跑。
    let deleted = 0;
    const ran = await runWithJobLease(
      this.redis,
      EVENT_RETENTION_JOB,
      60_000,
      async (_token, lease) => {
        deleted = await this.purgeExpiredEvents(lease);
      },
    );
    if (!ran) reportJobSkipped();
    return deleted;
  }

  /** 删到没有过期行为止;每批一个短事务,总时长封顶,剩下的明天接着删。 */
  private async purgeExpiredEvents(lease: JobLeaseContext): Promise<number> {
    const startedAt = Date.now();
    const before = new Date(startedAt - EVENT_RETENTION_DAYS * 86400_000);
    let total = 0;
    while (lease.isCurrent()) {
      const count = await this.prisma.$executeRaw`
        WITH expired AS (
          SELECT "id" FROM "ConsoleEvent"
          WHERE "createdAt" < ${before}
          ORDER BY "createdAt"
          LIMIT ${EVENT_RETENTION_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM "ConsoleEvent" AS target
        USING expired
        WHERE target."id" = expired."id"`;
      total += count;
      if (count < EVENT_RETENTION_BATCH) break;
      if (Date.now() - startedAt >= EVENT_RETENTION_BUDGET_MS) {
        this.logger.warn({
          event: 'console_event_retention_capped',
          deletedCount: total,
        });
        break;
      }
      await new Promise((done) => setTimeout(done, EVENT_RETENTION_PAUSE_MS));
    }
    return total;
  }
}
