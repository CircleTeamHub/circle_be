import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

const DEFAULT_REFRESH_TOKEN_TTL_DAYS = 7;
const MAX_DEVICE_NAME_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 256;
const MAX_IP_LENGTH = 64;

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
  private readonly ttlDays: number;

  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
  ) {
    const raw = this.config.get<string | number>('REFRESH_EXPIRES_IN_DAYS');
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw;
    this.ttlDays =
      typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0
        ? parsed
        : DEFAULT_REFRESH_TOKEN_TTL_DAYS;
  }

  async create(
    userId: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<{ token: string; sessionId: string }> {
    const rawToken = randomBytes(64).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiredAt = new Date();
    expiredAt.setDate(expiredAt.getDate() + this.ttlDays);

    const safe = normalizeContext(context);
    const session = await this.prisma.refreshToken.create({
      data: {
        userId,
        token: tokenHash,
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

  async rotate(
    oldToken: string,
    context?: SessionContext,
    audience: RefreshTokenAudience = 'APP',
  ): Promise<{ token: string; userId: string; sessionId: string }> {
    const tokenHash = hashToken(oldToken);
    const now = new Date();

    // Atomically revoke the token only if it hasn't been used yet.
    // Using updateMany + count check prevents the TOCTOU race where two
    // concurrent requests both pass a findUnique check before either writes
    // revokedAt, which would allow one token to spawn two live sessions.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: {
        token: tokenHash,
        revokedAt: null,
        expiredAt: { gt: now },
        audience,
      },
      data: { revokedAt: now },
    });

    if (revoked.count === 0) {
      // Determine whether this is reuse of an already-revoked token
      // (potential session hijack) vs an unknown/expired token.
      const existing = await this.prisma.refreshToken.findUnique({
        where: { token: tokenHash },
        select: {
          userId: true,
          revokedAt: true,
          expiredAt: true,
          audience: true,
        },
      });
      if (existing?.revokedAt && existing.audience === audience) {
        // Reuse detected: the legitimate holder rotated this token, and now
        // someone is replaying the old one. Assume compromise and kill the
        // entire session chain for this user.
        this.logger.warn(
          `Refresh token reuse detected for user ${existing.userId}; revoking all sessions.`,
        );
        await this.revokeAll(existing.userId);
        throw new UnauthorizedException(
          'Refresh token reuse detected; all sessions revoked',
        );
      }
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Fetch metadata needed to carry over device context to the new token.
    const record = await this.prisma.refreshToken.findUnique({
      where: { token: tokenHash },
      select: {
        userId: true,
        deviceName: true,
        ip: true,
        userAgent: true,
        audience: true,
      },
    });

    if (!record) {
      // Should be unreachable given the updateMany above succeeded.
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const newSession = await this.create(record.userId, {
      deviceName: context?.deviceName ?? record.deviceName ?? null,
      ip: context?.ip ?? record.ip ?? null,
      userAgent: context?.userAgent ?? record.userAgent ?? null,
    }, record.audience);
    return {
      token: newSession.token,
      userId: record.userId,
      sessionId: newSession.sessionId,
    };
  }

  async revoke(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    await this.prisma.refreshToken.updateMany({
      where: { token: tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
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

  async revokeAll(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async revokeOtherSessions(
    userId: string,
    currentSessionId?: string,
  ): Promise<void> {
    if (!currentSessionId) {
      return;
    }

    await this.prisma.refreshToken.updateMany({
      where: {
        userId,
        revokedAt: null,
        id: { not: currentSessionId },
      },
      data: { revokedAt: new Date() },
    });
  }
}
