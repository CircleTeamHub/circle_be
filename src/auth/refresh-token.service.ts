import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronExpression } from '@nestjs/schedule';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Prisma, RefreshTokenRevocationReason } from 'src/generated/prisma';
import {
  reportHandledJobFailure,
  reportJobSkipped,
  TrackedCron,
} from 'src/metrics/tracked-cron.decorator';
import { PrismaService } from 'src/prisma/prisma.service';
import { SessionRevocationService } from './session-revocation.service';

const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 7;
// 管理台会话故意比用户短一个量级（#91 目标区间 8-24h）：一枚被偷的 admin
// refresh token 的价值远高于普通用户，续命窗口必须收紧。
const DEFAULT_ADMIN_REFRESH_TTL = '12h';
const MAX_DEVICE_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 256;
const MAX_IP_LENGTH = 64;
const REVOCATION_BATCH_SIZE = 25;
const REVOCATION_PAGE_SIZE = 100;
const ACCESS_REVOCATION_CLAIM_LEASE_MS = 2 * 60_000;
// GET /auth/sessions 的上限：正常账号只有个位数设备，100 足够列全真实会话，又不让
// 一个刷出成千上万条会话的账号每次打开设备管理都把它们全拉回来。
const ACTIVE_SESSION_LIST_LIMIT = 100;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * 解析 refresh TTL 配置（#84）。接受 '30d' / '12h' / '45m' / 纯数字（=天，
 * 兼容旧 REFRESH_EXPIRES_IN_DAYS 语义）。无法解析返回 null，由调用方回落默认
 * 并告警 —— 静默把错误配置当默认值吞掉正是这个 issue 的病根。
 */
export function parseRefreshTtlMs(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value * MS_PER_DAY : null;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  const match = /^(\d+)\s*([dhm]?)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    return null;
  }
  switch (match[2].toLowerCase()) {
    case 'h':
      return amount * MS_PER_HOUR;
    case 'm':
      return amount * MS_PER_MINUTE;
    // 裸数字与 'd' 同义：与旧 REFRESH_EXPIRES_IN_DAYS 的「天数」语义兼容。
    default:
      return amount * MS_PER_DAY;
  }
}

export type SessionContext = {
  deviceName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /** sha256(x-device-id)；绑定会话与受信任设备。 */
  deviceKey?: string | null;
};

export type RefreshTokenAudience = 'APP' | 'ADMIN';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function truncate(
  value: string | null | undefined,
  max: number,
): string | null {
  if (value === null || value === undefined) return null;
  return value.length > max ? value.slice(0, max) : value;
}

function normalizeContext(context?: SessionContext): SessionContext {
  return {
    deviceName: truncate(context?.deviceName, MAX_DEVICE_NAME_LENGTH),
    ip: truncate(context?.ip, MAX_IP_LENGTH),
    userAgent: truncate(context?.userAgent, MAX_USER_AGENT_LENGTH),
    deviceKey: context?.deviceKey ?? null,
  };
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlMs: number;
  private readonly adminTtlMs: number;
  private accessRevocationSweepRunning = false;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private readonly revocation: SessionRevocationService,
  ) {
    // #84：读 schema/模板一直文档化的 REFRESH_EXPIRES_IN（此前代码读的是从未
    // 见诸任何模板的 REFRESH_EXPIRES_IN_DAYS，导致所有环境静默拿 7 天默认）。
    // 旧名保留为兼容回落（带弃用告警），两者都无效才落进 7 天默认。
    const documented = parseRefreshTtlMs(
      this.config.get<string | number>('REFRESH_EXPIRES_IN'),
    );
    const legacyRaw = this.config.get<string | number>(
      'REFRESH_EXPIRES_IN_DAYS',
    );
    const legacy = parseRefreshTtlMs(legacyRaw);
    if (documented === null && legacy !== null) {
      this.logger.warn(
        'REFRESH_EXPIRES_IN_DAYS is deprecated — set REFRESH_EXPIRES_IN (e.g. "30d") instead',
      );
    }
    if (
      documented === null &&
      legacy === null &&
      this.config.get('REFRESH_EXPIRES_IN') !== undefined
    ) {
      this.logger.warn(
        `REFRESH_EXPIRES_IN="${String(this.config.get('REFRESH_EXPIRES_IN'))}" is not parseable; falling back to ${DEFAULT_REFRESH_TOKEN_TTL_DAYS}d`,
      );
    }
    this.ttlMs =
      documented ?? legacy ?? DEFAULT_REFRESH_TOKEN_TTL_DAYS * MS_PER_DAY;

    // #91：ADMIN audience 独立 TTL，绝不长于普通用户的。
    const adminConfigured = parseRefreshTtlMs(
      this.config.get<string | number>('ADMIN_REFRESH_EXPIRES_IN'),
    );
    this.adminTtlMs = Math.min(
      adminConfigured ?? parseRefreshTtlMs(DEFAULT_ADMIN_REFRESH_TTL)!,
      this.ttlMs,
    );
  }

  /** 各 audience 的会话 TTL（毫秒）。导出仅为测试可见性。 */
  ttlMsFor(audience: RefreshTokenAudience): number {
    return audience === 'ADMIN' ? this.adminTtlMs : this.ttlMs;
  }

  async create(
    userId: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<{ token: string; sessionId: string }> {
    return this.createWithClient(this.prisma, userId, context, audience);
  }

  private async createWithClient(
    client: PrismaService | Prisma.TransactionClient,
    userId: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
    familyId: string = randomUUID(),
  ): Promise<{ token: string; sessionId: string }> {
    const rawToken = randomBytes(64).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiredAt = new Date(Date.now() + this.ttlMsFor(audience));

    const safe = normalizeContext(context);
    const session = await client.refreshToken.create({
      data: {
        userId,
        token: tokenHash,
        familyId,
        expiredAt,
        deviceName: safe.deviceName,
        ip: safe.ip,
        userAgent: safe.userAgent,
        deviceKey: safe.deviceKey,
        audience,
        lastUsedAt: new Date(),
      },
    });

    return { token: rawToken, sessionId: session.id };
  }

  private async revokeAccessSessions(sessionIds: string[]): Promise<string[]> {
    const notified: string[] = [];
    for (
      let offset = 0;
      offset < sessionIds.length;
      offset += REVOCATION_BATCH_SIZE
    ) {
      const batch = sessionIds.slice(offset, offset + REVOCATION_BATCH_SIZE);
      const results = await Promise.all(
        batch.map(async (sessionId) => ({
          sessionId,
          delivered: await this.revocation.revokeSession(sessionId),
        })),
      );
      notified.push(
        ...results
          // Older mocks and compatible implementations returned void; only an
          // explicit false means pub/sub delivery needs an outbox retry.
          .filter(({ delivered }) => delivered !== false)
          .map(({ sessionId }) => sessionId),
      );
    }
    return notified;
  }

  private async notifyPendingAccessRevocations(
    where: Prisma.RefreshTokenWhereInput,
  ): Promise<number> {
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - ACCESS_REVOCATION_CLAIM_LEASE_MS,
    );
    const leaseToken = randomUUID();
    const eligibleAccessToken: Prisma.RefreshTokenWhereInput = {
      OR: [
        { accessTokenExpiresAt: { gt: now } },
        {
          accessTokenExpiresAt: null,
          expiredAt: { gt: now },
        },
      ],
    };
    const availableLease: Prisma.RefreshTokenWhereInput = {
      OR: [
        { accessRevocationLockedAt: null },
        { accessRevocationLockedAt: { lte: staleBefore } },
      ],
    };
    const page = await this.prisma.refreshToken.findMany({
      where: {
        AND: [
          where,
          {
            accessRevokedAt: { not: null },
            accessRevocationNotifiedAt: null,
          },
          eligibleAccessToken,
          availableLease,
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: REVOCATION_PAGE_SIZE,
    });
    if (page.length === 0) return 0;

    const candidateIds = page.map(({ id }) => id);
    await this.prisma.refreshToken.updateMany({
      where: {
        AND: [
          { id: { in: candidateIds } },
          {
            accessRevokedAt: { not: null },
            accessRevocationNotifiedAt: null,
          },
          eligibleAccessToken,
          availableLease,
        ],
      },
      data: {
        accessRevocationLockedAt: now,
        accessRevocationLeaseToken: leaseToken,
      },
    });
    const claimed = await this.prisma.refreshToken.findMany({
      where: {
        id: { in: candidateIds },
        accessRevocationLeaseToken: leaseToken,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: REVOCATION_PAGE_SIZE,
    });
    const sessionIds = claimed.map(({ id }) => id);
    if (sessionIds.length === 0) return 0;

    const notifiedSessionIds = await this.revokeAccessSessions(sessionIds);
    if (notifiedSessionIds.length > 0) {
      await this.prisma.refreshToken.updateMany({
        where: {
          id: { in: notifiedSessionIds },
          accessRevocationNotifiedAt: null,
          accessRevocationLeaseToken: leaseToken,
        },
        data: {
          accessRevocationNotifiedAt: new Date(),
          accessRevocationLockedAt: null,
          accessRevocationLeaseToken: null,
        },
      });
    }
    const failedSessionIds = sessionIds.filter(
      (sessionId) => !notifiedSessionIds.includes(sessionId),
    );
    if (failedSessionIds.length > 0) {
      await this.prisma.refreshToken.updateMany({
        where: {
          id: { in: failedSessionIds },
          accessRevocationLeaseToken: leaseToken,
        },
        data: {
          accessRevocationLockedAt: null,
          accessRevocationLeaseToken: null,
        },
      });
      reportHandledJobFailure();
    }
    return sessionIds.length;
  }

  private async notifyPendingAccessRevocationsBestEffort(
    where: Prisma.RefreshTokenWhereInput,
  ): Promise<void> {
    try {
      await this.notifyPendingAccessRevocations(where);
    } catch (error) {
      this.logger.warn({
        event: 'access_revocation_delivery_deferred',
        errorType: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /**
   * RefreshToken rows are the durable outbox for per-session Redis markers and
   * socket-close broadcasts. One bounded page per minute keeps request work
   * capped while guaranteeing that overflow from large rotation chains is
   * eventually delivered after transient failures or process restarts.
   */
  @TrackedCron(CronExpression.EVERY_MINUTE, 'access_revocation_outbox')
  async flushPendingAccessRevocations(): Promise<void> {
    if (this.accessRevocationSweepRunning) {
      reportJobSkipped();
      return;
    }
    this.accessRevocationSweepRunning = true;
    try {
      await this.notifyPendingAccessRevocations({});
    } finally {
      this.accessRevocationSweepRunning = false;
    }
  }

  async recordAccessTokenIssued(
    userId: string,
    sessionId: string,
    expiresAt: Date,
  ): Promise<void> {
    const updated = await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId },
      data: { accessTokenExpiresAt: expiresAt },
    });
    if (updated.count !== 1) {
      throw new UnauthorizedException('Session is no longer active');
    }
  }

  private async markAccessRevokedWithClient(
    tx: Prisma.TransactionClient,
    where: Prisma.RefreshTokenWhereInput,
    revokedAt: Date,
  ): Promise<void> {
    // Pre-migration rows do not know their exact access-token expiry. Their
    // refresh expiry is the only durable upper bound that survives a later
    // JWT_EXPIRES_IN reduction, so keep them revocable until that bound. This
    // may retain/broadcast a row longer than its access JWT actually lives, but
    // never lets a still-valid legacy JWT escape revocation.
    await tx.refreshToken.updateMany({
      where: {
        AND: [
          where,
          {
            accessRevokedAt: null,
            accessTokenExpiresAt: null,
            expiredAt: { gt: revokedAt },
          },
        ],
      },
      data: {
        accessRevokedAt: revokedAt,
        accessRevocationNotifiedAt: null,
        accessRevocationLockedAt: null,
        accessRevocationLeaseToken: null,
      },
    });
    await tx.refreshToken.updateMany({
      where: {
        AND: [
          where,
          {
            accessRevokedAt: null,
            accessTokenExpiresAt: { gt: revokedAt },
          },
        ],
      },
      data: {
        accessRevokedAt: revokedAt,
        accessRevocationNotifiedAt: null,
        accessRevocationLockedAt: null,
        accessRevocationLeaseToken: null,
      },
    });
  }

  private async replaceForSingleDeviceWithClient(
    tx: Prisma.TransactionClient,
    userId: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ) {
    const now = new Date();
    await this.markAccessRevokedWithClient(tx, { userId, audience }, now);
    await tx.refreshToken.updateMany({
      where: { userId, audience, revokedAt: null },
      data: {
        revokedAt: now,
        revocationReason: RefreshTokenRevocationReason.SINGLE_DEVICE_REPLACED,
      },
    });
    const session = await this.createWithClient(tx, userId, context, audience);
    return {
      session,
      accessRevokedAt: now,
      accessRevocationWhere: { userId, audience },
    };
  }

  async createSessionForCurrentSingleDeviceSetting(
    userId: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<{ token: string; sessionId: string }> {
    const result = await this.prisma.$transaction(async (tx) => {
      const lockKey = `auth-user:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { singleDeviceLoginEnabled: true },
      });
      if (!user) {
        throw new UnauthorizedException('Invalid or inactive account');
      }
      if (user.singleDeviceLoginEnabled) {
        return this.replaceForSingleDeviceWithClient(
          tx,
          userId,
          context,
          audience,
        );
      }
      return {
        session: await this.createWithClient(tx, userId, context, audience),
        accessRevokedAt: null,
        accessRevocationWhere: null,
      };
    });
    if (result.accessRevokedAt && result.accessRevocationWhere) {
      await this.notifyPendingAccessRevocationsBestEffort({
        ...result.accessRevocationWhere,
        accessRevokedAt: result.accessRevokedAt,
      });
    }
    return result.session;
  }

  async createAppSession(
    userId: string,
    context?: SessionContext,
  ): Promise<{ token: string; sessionId: string }> {
    return this.createSessionForCurrentSingleDeviceSetting(
      userId,
      context,
      'APP',
    );
  }

  async replaceForSingleDevice(
    userId: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<{ token: string; sessionId: string }> {
    const replacement = await this.prisma.$transaction(async (tx) => {
      const lockKey = `auth-user:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      return this.replaceForSingleDeviceWithClient(
        tx,
        userId,
        context,
        audience,
      );
    });
    await this.notifyPendingAccessRevocationsBestEffort({
      ...replacement.accessRevocationWhere,
      accessRevokedAt: replacement.accessRevokedAt,
    });
    return replacement.session;
  }

  async setSingleDeviceLogin(
    userId: string,
    enabled: boolean,
    currentSessionId?: string,
  ): Promise<void> {
    const accessRevocation = await this.prisma.$transaction(async (tx) => {
      const lockKey = `auth-user:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      await tx.user.update({
        where: { id: userId },
        data: { singleDeviceLoginEnabled: enabled },
      });
      if (!enabled) return null;

      const now = new Date();
      const current = currentSessionId
        ? await tx.refreshToken.findFirst({
            where: { id: currentSessionId, userId },
            select: { familyId: true },
          })
        : null;
      let preserveCurrent: Prisma.RefreshTokenWhereInput = {};
      if (current) {
        preserveCurrent = { familyId: { not: current.familyId } };
      } else if (currentSessionId) {
        preserveCurrent = { id: { not: currentSessionId } };
      }
      const target = { userId, ...preserveCurrent };
      await this.markAccessRevokedWithClient(tx, target, now);
      await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...preserveCurrent,
        },
        data: {
          revokedAt: now,
          revocationReason: RefreshTokenRevocationReason.OTHER_SESSIONS_REVOKED,
        },
      });
      return { accessRevokedAt: now, where: target };
    });
    if (accessRevocation) {
      await this.notifyPendingAccessRevocationsBestEffort({
        ...accessRevocation.where,
        accessRevokedAt: accessRevocation.accessRevokedAt,
      });
    }
  }

  async ownerForToken(
    rawToken: string,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<string> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { token: hashToken(rawToken) },
      select: { userId: true, audience: true },
    });
    if (!row || row.audience !== audience)
      throw new UnauthorizedException('Invalid or expired refresh token');
    return row.userId;
  }

  async rotate(
    oldToken: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<{
    token: string;
    userId: string;
    sessionId: string;
    deviceKey: string | null;
    deviceName: string | null;
  }> {
    const tokenHash = hashToken(oldToken);
    const result = await this.prisma.$transaction(async (tx) => {
      const initial = await tx.refreshToken.findUnique({
        where: { token: tokenHash },
        select: { userId: true, audience: true },
      });
      if (!initial || initial.audience !== audience) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      const lockKey = `auth-user:${initial.userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const record = await tx.refreshToken.findUnique({
        where: { token: tokenHash },
        select: {
          userId: true,
          deviceName: true,
          ip: true,
          userAgent: true,
          deviceKey: true,
          audience: true,
          familyId: true,
          revokedAt: true,
          revocationReason: true,
          expiredAt: true,
        },
      });
      if (!record || record.audience !== audience) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      const now = new Date();
      if (record.expiredAt <= now) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      if (record.revokedAt) {
        if (
          record.revocationReason !== RefreshTokenRevocationReason.ROTATED &&
          record.revocationReason !== null
        ) {
          throw new UnauthorizedException('Invalid or expired refresh token');
        }
        const familySessions = await tx.refreshToken.findMany({
          where: {
            userId: record.userId,
            familyId: record.familyId,
            expiredAt: { gt: now },
          },
          select: { id: true },
        });
        await tx.refreshToken.updateMany({
          where: {
            userId: record.userId,
            familyId: record.familyId,
            revokedAt: null,
          },
          data: {
            revokedAt: now,
            revocationReason: RefreshTokenRevocationReason.TOKEN_FAMILY_REUSE,
          },
        });
        await tx.user.update({
          where: { id: record.userId },
          data: { accessTokensRevokedAt: now },
        });
        return {
          kind: 'reuse' as const,
          userId: record.userId,
          sessionIds: familySessions.map(({ id }) => id),
        };
      }

      const revoked = await tx.refreshToken.updateMany({
        where: {
          token: tokenHash,
          revokedAt: null,
          expiredAt: { gt: now },
          audience,
        },
        data: {
          revokedAt: now,
          revocationReason: RefreshTokenRevocationReason.ROTATED,
        },
      });
      if (revoked.count !== 1) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      const newSession = await this.createWithClient(
        tx,
        record.userId,
        {
          deviceName: context?.deviceName ?? record.deviceName ?? null,
          ip: context?.ip ?? record.ip ?? null,
          userAgent: context?.userAgent ?? record.userAgent ?? null,
          // 会话一旦绑定设备就不再改绑：换设备 ID 续签同一个 refresh token
          // 只可能是令牌被拷走，不能借此把别的设备「洗」成受信任。
          deviceKey: record.deviceKey ?? context?.deviceKey ?? null,
        },
        record.audience,
        record.familyId,
      );
      return {
        kind: 'rotated' as const,
        token: newSession.token,
        userId: record.userId,
        sessionId: newSession.sessionId,
        deviceKey: record.deviceKey ?? context?.deviceKey ?? null,
        deviceName: context?.deviceName ?? record.deviceName ?? null,
      };
    });

    if (result.kind === 'reuse') {
      this.logger.warn(
        `Refresh token reuse detected for user ${result.userId}; revoking the affected token family.`,
      );
      await this.revokeAccessSessions(result.sessionIds);
      throw new UnauthorizedException(
        'Refresh token reuse detected; token family revoked',
      );
    }
    return result;
  }

  async assertSessionActive(userId: string, sessionId: string): Promise<void> {
    const active = await this.prisma.refreshToken.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiredAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (!active) {
      throw new UnauthorizedException('Session is no longer active');
    }
  }

  /**
   * 撤销单枚 refresh token。返回被撤销会话的归属（无匹配时 null），
   * 供调用方补审计日志（#90 —— admin 登出此前完全无痕）。
   */
  async revoke(token: string): Promise<{
    userId: string;
    audience: RefreshTokenAudience;
    sessionId: string;
  } | null> {
    const tokenHash = hashToken(token);
    // The row id is the session id carried in the access token's `sid` claim;
    // fetch it so we can revoke the matching access token too (F-02), not just
    // the refresh token.
    const existing = await this.prisma.refreshToken.findUnique({
      where: { token: tokenHash },
      select: { id: true, userId: true, audience: true },
    });
    const revoked = await this.prisma.refreshToken.updateMany({
      // review 修复（round 2）：过期未撤销的行同样不算「真撤销」——旧 ADMIN
      // refresh token 过期后被拿来「登出」，不该再记一条成功审计（会话早已
      // 自然死亡，什么都没被结束）。
      where: {
        token: tokenHash,
        revokedAt: null,
        expiredAt: { gt: new Date() },
      },
      data: {
        revokedAt: new Date(),
        revocationReason: RefreshTokenRevocationReason.LOGOUT,
      },
    });
    // round 3 review：refresh TTL 可配得比 access TTL 短 —— 行过期不代表
    // 对应 access token 已死。只要行存在就写会话吊销标记（幂等且便宜），
    // 让登出语义对 access token 始终成立；归属/审计仍只在真撤销时返回。
    if (existing) {
      await this.revocation.revokeSession(existing.id);
    }
    // token 已被撤销过 / 已过期（updateMany 0 行）时不返回归属。
    if (existing && revoked.count > 0) {
      return {
        userId: existing.userId,
        audience: existing.audience as RefreshTokenAudience,
        sessionId: existing.id,
      };
    }
    return null;
  }

  listActiveSessions(userId: string) {
    return this.prisma.refreshToken.findMany({
      where: {
        userId,
        revokedAt: null,
        expiredAt: { gt: new Date() },
      },
      select: {
        id: true,
        deviceName: true,
        ip: true,
        userAgent: true,
        createdAt: true,
        lastUsedAt: true,
        expiredAt: true,
      },
      // 最近使用的在前；同一时刻按创建时间、再按 id 兜底，顺序与截断结果都稳定。
      orderBy: [{ lastUsedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: ACTIVE_SESSION_LIST_LIMIT,
    });
  }

  /** 仅写 access token 吊销标记（DB 撤销已由调用方事务完成时用）。 */
  async revokeAllAccessMarkers(userId: string): Promise<void> {
    await this.revocation.revokeUser(userId);
  }

  async revokeAll(userId: string): Promise<void> {
    const revokedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: {
          revokedAt,
          revocationReason: RefreshTokenRevocationReason.LOGOUT_ALL,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: { accessTokensRevokedAt: revokedAt },
      }),
    ]);
    // Kill every access token this user already holds (logout-all / ban /
    // password change / reuse detection), not just their refresh tokens (F-02).
    await this.revocation.revokeUser(userId);
  }

  /** 会话绑定的设备（sha256 设备 ID）；不是本人的会话 / 没绑定返回 null。 */
  async findSessionDeviceKey(
    userId: string,
    sessionId: string,
  ): Promise<string | null> {
    const session = await this.prisma.refreshToken.findFirst({
      where: { id: sessionId, userId },
      select: { deviceKey: true },
    });
    return session?.deviceKey ?? null;
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revocationReason: RefreshTokenRevocationReason.SESSION_REVOKED,
      },
    });
    // 0 行（已撤销 / 已过期 / 不是本人的会话）照旧按成功返回，不改成 404：APP 的设备
    // 管理页把任何错误都显示成「移除失败」且不刷新列表，列表加载后会话恰好过期、另一台
    // 设备先把它登出这类良性竞态都会被报成失败；撤销当前会话时还会卡住「清本地会话 →
    // 回登录页」。同样的回应也不给「这个 id 是否属于别人」留探测口。
    if (result.count === 1) {
      await this.revocation.revokeSession(sessionId);
    }
  }

  /** 撤销绑定到某台设备的全部会话（设备管理里移除设备时用）。 */
  async revokeDeviceSessions(userId: string, deviceKey: string): Promise<void> {
    const revokedAt = await this.prisma.$transaction(async (tx) => {
      const lockKey = `auth-user:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const now = new Date();
      await this.markAccessRevokedWithClient(tx, { userId, deviceKey }, now);
      await tx.refreshToken.updateMany({
        where: { userId, deviceKey, revokedAt: null },
        data: {
          revokedAt: now,
          revocationReason: RefreshTokenRevocationReason.SESSION_REVOKED,
        },
      });
      return now;
    });
    await this.notifyPendingAccessRevocationsBestEffort({
      userId,
      deviceKey,
      accessRevokedAt: revokedAt,
    });
  }

  async revokeOtherSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<void> {
    if (!currentSessionId) {
      return;
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const lockKey = `auth-user:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const current = await tx.refreshToken.findFirst({
        where: { id: currentSessionId, userId },
        select: { familyId: true },
      });
      const keepCurrent: Prisma.RefreshTokenWhereInput = current
        ? { familyId: { not: current.familyId } }
        : { id: { not: currentSessionId } };
      const now = new Date();
      await this.markAccessRevokedWithClient(
        tx,
        { userId, ...keepCurrent },
        now,
      );
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null, ...keepCurrent },
        data: {
          revokedAt: now,
          revocationReason: RefreshTokenRevocationReason.OTHER_SESSIONS_REVOKED,
        },
      });
      return { revokedAt: now, keepCurrent };
    });
    await this.notifyPendingAccessRevocationsBestEffort({
      userId,
      ...result.keepCurrent,
      accessRevokedAt: result.revokedAt,
    });
  }
}
