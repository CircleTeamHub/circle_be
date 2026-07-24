import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { Prisma, RefreshTokenRevocationReason } from 'src/generated/prisma';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  accessTokenTtlSeconds,
  SessionRevocationService,
} from './session-revocation.service';

const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 7;
// 管理台会话故意比用户短一个量级（#91 目标区间 8-24h）：一枚被偷的 admin
// refresh token 的价值远高于普通用户，续命窗口必须收紧。
const DEFAULT_ADMIN_REFRESH_TTL = '12h';
const MAX_DEVICE_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 256;
const MAX_IP_LENGTH = 64;
const REVOCATION_BATCH_SIZE = 25;

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
  };
}

@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);
  private readonly ttlMs: number;
  private readonly adminTtlMs: number;
  private readonly accessTtlMs: number;

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
    this.accessTtlMs =
      accessTokenTtlSeconds(
        this.config.get<string | number>('JWT_EXPIRES_IN') ?? '1h',
      ) * 1000;
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
        audience,
        lastUsedAt: new Date(),
      },
    });

    return { token: rawToken, sessionId: session.id };
  }

  private async revokeAccessSessions(sessionIds: string[]): Promise<void> {
    for (
      let offset = 0;
      offset < sessionIds.length;
      offset += REVOCATION_BATCH_SIZE
    ) {
      const batch = sessionIds.slice(offset, offset + REVOCATION_BATCH_SIZE);
      await Promise.all(
        batch.map((sessionId) => this.revocation.revokeSession(sessionId)),
      );
    }
  }

  private async replaceForSingleDeviceWithClient(
    tx: Prisma.TransactionClient,
    userId: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ) {
    const now = new Date();
    const revocableSessions = await tx.refreshToken.findMany({
      where: { userId, audience, expiredAt: { gt: now } },
      select: { id: true },
    });
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
      revokedSessionIds: revocableSessions.map(({ id }) => id),
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
        revokedSessionIds: [],
      };
    });
    await this.revokeAccessSessions(result.revokedSessionIds);
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
    await this.revokeAccessSessions(replacement.revokedSessionIds);
    return replacement.session;
  }

  async setSingleDeviceLogin(
    userId: string,
    enabled: boolean,
    currentSessionId?: string,
  ): Promise<void> {
    const revokedSessionIds = await this.prisma.$transaction(async (tx) => {
      const lockKey = `auth-user:${userId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      await tx.user.update({
        where: { id: userId },
        data: { singleDeviceLoginEnabled: enabled },
      });
      if (!enabled) return [];

      const now = new Date();
      const revocableSessions = await tx.refreshToken.findMany({
        where: {
          userId,
          expiredAt: { gt: now },
          ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
        },
        select: { id: true },
      });
      await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(currentSessionId ? { id: { not: currentSessionId } } : {}),
        },
        data: {
          revokedAt: now,
          revocationReason: RefreshTokenRevocationReason.OTHER_SESSIONS_REVOKED,
        },
      });
      return revocableSessions.map(({ id }) => id);
    });
    await this.revokeAccessSessions(revokedSessionIds);
  }

  async rotate(
    oldToken: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<{ token: string; userId: string; sessionId: string }> {
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
        },
        record.audience,
        record.familyId,
      );
      return {
        kind: 'rotated' as const,
        token: newSession.token,
        userId: record.userId,
        sessionId: newSession.sessionId,
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
      orderBy: {
        lastUsedAt: 'desc',
      },
    });
  }

  /** 仅写 access token 吊销标记（DB 撤销已由调用方事务完成时用）。 */
  async revokeAllAccessMarkers(userId: string): Promise<void> {
    await this.revocation.revokeUser(userId);
  }

  async revokeAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revocationReason: RefreshTokenRevocationReason.LOGOUT_ALL,
      },
    });
    // Kill every access token this user already holds (logout-all / ban /
    // password change / reuse detection), not just their refresh tokens (F-02).
    await this.revocation.revokeUser(userId);
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: {
        revokedAt: new Date(),
        revocationReason: RefreshTokenRevocationReason.SESSION_REVOKED,
      },
    });
    if (result.count === 1) {
      await this.revocation.revokeSession(sessionId);
    }
  }

  async revokeOtherSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<void> {
    if (!currentSessionId) {
      return;
    }

    const revokedSessions = await this.prisma.refreshToken.updateManyAndReturn({
      where: {
        userId,
        revokedAt: null,
        id: { not: currentSessionId },
      },
      data: {
        revokedAt: new Date(),
        revocationReason: RefreshTokenRevocationReason.OTHER_SESSIONS_REVOKED,
      },
      select: { id: true },
    });
    await this.revokeAccessSessions(revokedSessions.map(({ id }) => id));
  }
}
