import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

const REFRESH_TOKEN_TTL_DAYS = 7;

export type SessionContext = {
  deviceName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class RefreshTokenService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, context?: SessionContext): Promise<string> {
    const rawToken = randomBytes(64).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiredAt = new Date();
    expiredAt.setDate(expiredAt.getDate() + REFRESH_TOKEN_TTL_DAYS);

    await this.prisma.refreshToken.create({
      data: {
        userId,
        token: tokenHash,
        expiredAt,
        deviceName: context?.deviceName ?? null,
        ip: context?.ip ?? null,
        userAgent: context?.userAgent ?? null,
        lastUsedAt: new Date(),
      },
    });

    return rawToken;
  }

  async rotate(
    oldToken: string,
    context?: SessionContext,
  ): Promise<{ token: string; userId: string }> {
    const tokenHash = hashToken(oldToken);
    const now = new Date();

    // Atomically revoke the token only if it hasn't been used yet.
    // Using updateMany + count check prevents the TOCTOU race where two
    // concurrent requests both pass a findUnique check before either writes
    // revokedAt, which would allow one token to spawn two live sessions.
    const revoked = await this.prisma.refreshToken.updateMany({
      where: { token: tokenHash, revokedAt: null, expiredAt: { gt: now } },
      data: { revokedAt: now },
    });

    if (revoked.count === 0) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Fetch metadata needed to carry over device context to the new token.
    const record = await this.prisma.refreshToken.findUnique({
      where: { token: tokenHash },
      select: { userId: true, deviceName: true, ip: true, userAgent: true },
    });

    if (!record) {
      // Should be unreachable given the updateMany above succeeded.
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const newToken = await this.create(record.userId, {
      deviceName: context?.deviceName ?? record.deviceName ?? null,
      ip: context?.ip ?? record.ip ?? null,
      userAgent: context?.userAgent ?? record.userAgent ?? null,
    });
    return { token: newToken, userId: record.userId };
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
}
