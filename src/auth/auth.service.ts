import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from 'src/prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenService, SessionContext } from './refresh-token.service';
import { OpenimService } from 'src/openim/openim.service';

const ME_SELECT = {
  id: true,
  accountId: true,
  nickname: true,
  avatarUrl: true,
  avatarFrame: true,
  cover: true,
  email: true,
  phoneNumber: true,
  wechat: true,
  qq: true,
  whatsup: true,
  persona: true,
  helloWords: true,
  birthday: true,
  gender: true,
  city: true,
  role: true,
  status: true,
  lastOnline: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type SafeUser = {
  id: string;
  accountId: string;
  nickname: string;
  avatarUrl: string | null;
  avatarFrame: string | null;
  cover: string | null;
  email: string | null;
  phoneNumber: string | null;
  wechat: string | null;
  qq: string | null;
  whatsup: string | null;
  persona: string | null;
  helloWords: string | null;
  birthday: Date | null;
  gender: string;
  city: string | null;
  role: string;
  status: string;
  lastOnline: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private refreshTokenService: RefreshTokenService,
    private jwt: JwtService,
    private openim: OpenimService,
  ) {}

  async register(dto: RegisterDto, sessionContext?: SessionContext) {
    const existing = await this.prisma.user.findUnique({
      where: { accountId: dto.accountId },
    });
    if (existing) {
      throw new ConflictException('Account ID already taken');
    }

    const passwordHash = await argon2.hash(dto.password);

    const user = await this.prisma.user.create({
      data: {
        accountId: dto.accountId,
        passwordHash,
        nickname: dto.nickname || dto.accountId,
        email: dto.email,
        phoneNumber: dto.phoneNumber,
      },
    });

    // Sync to OpenIM non-blocking. Mark openimSynced=true on success so
    // login() can detect and retry if this first attempt failed.
    this.openim
      .registerUser(user.id, user.nickname, user.avatarUrl)
      .then(() =>
        this.prisma.user.update({
          where: { id: user.id },
          data: { openimSynced: true },
        }),
      )
      .catch((err) =>
        this.logger.warn(
          `OpenIM registerUser failed for ${user.id}: ${err?.message}. Will retry on next login.`,
        ),
      );

    return this.issueTokens(user.id, user.accountId, user.role, sessionContext);
  }

  async login(dto: LoginDto, sessionContext?: SessionContext) {
    const user = await this.prisma.user.findUnique({
      where: { accountId: dto.accountId },
    });

    // Use the same error for "no such user" and "inactive user" so the
    // endpoint cannot be used as an account-enumeration oracle. The actual
    // reason is logged server-side for ops debugging.
    if (!user || user.status !== 'ACTIVE') {
      if (user && user.status !== 'ACTIVE') {
        this.logger.warn(
          `Login attempt for non-active account ${user.id} (status=${user.status})`,
        );
      }
      throw new ForbiddenException('Invalid credentials');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new ForbiddenException('Invalid credentials');
    }

    // Retry OpenIM registration for users that weren't synced at register time
    // (e.g. OpenIM was down). Non-blocking — login succeeds regardless.
    if (!user.openimSynced) {
      this.openim
        .registerUser(user.id, user.nickname, user.avatarUrl)
        .then(() =>
          this.prisma.user.update({
            where: { id: user.id },
            data: { openimSynced: true },
          }),
        )
        .catch((err) =>
          this.logger.warn(
            `OpenIM re-sync failed for ${user.id}: ${err?.message}`,
          ),
        );
    }

    // Fire-and-forget: lastOnline is best-effort and must never block token issuance.
    this.prisma.user
      .update({ where: { id: user.id }, data: { lastOnline: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${user.id}: ${err?.message}`,
        ),
      );

    return this.issueTokens(user.id, user.accountId, user.role, sessionContext);
  }

  async refresh(refreshToken: string, sessionContext?: SessionContext) {
    const { token: newRefreshToken, userId } =
      await this.refreshTokenService.rotate(refreshToken, sessionContext);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Banned/deleted users must not be able to keep refreshing tokens just
    // because they still hold a valid refresh token. Revoke their sessions
    // and reject the rotation result.
    if (user.status !== 'ACTIVE') {
      this.logger.warn(
        `Refresh blocked for non-active user ${user.id} (status=${user.status}); revoking sessions.`,
      );
      await this.refreshTokenService.revokeAll(user.id);
      throw new ForbiddenException('Account is not active');
    }

    // Fire-and-forget: lastOnline is best-effort and must never block token issuance.
    this.prisma.user
      .update({ where: { id: user.id }, data: { lastOnline: new Date() } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${user.id}: ${err?.message}`,
        ),
      );

    const accessToken = await this.signAccessToken(
      user.id,
      user.accountId,
      user.role,
    );
    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.refreshTokenService.revoke(refreshToken);
  }

  async sessions(userId: string) {
    return this.refreshTokenService.listActiveSessions(userId);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.refreshTokenService.revokeAll(userId);
  }

  async me(userId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: ME_SELECT,
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Fire-and-forget lastOnline update so a DB hiccup never blocks the read
    // and never produces a fabricated "success" response. The returned shape
    // shows the optimistic timestamp; persistence is best-effort.
    const now = new Date();
    this.prisma.user
      .update({ where: { id: userId }, data: { lastOnline: now } })
      .catch((err) =>
        this.logger.warn(
          `lastOnline update failed for ${userId}: ${err?.message}`,
        ),
      );

    return { ...user, lastOnline: now };
  }

  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const valid = await argon2.verify(user.passwordHash, oldPassword);
    if (!valid) {
      throw new UnauthorizedException('Current password is incorrect');
    }

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    // Invalidate all existing sessions after password change
    await this.refreshTokenService.revokeAll(userId);
  }

  private async issueTokens(
    userId: string,
    accountId: string,
    role: string,
    sessionContext?: SessionContext,
  ) {
    const [accessToken, refreshToken, imToken] = await Promise.all([
      this.signAccessToken(userId, accountId, role),
      this.refreshTokenService.create(userId, sessionContext),
      this.openim.getUserToken(userId).catch((err) => {
        this.logger.warn(`OpenIM getUserToken failed: ${err?.message}`);
        return '';
      }),
    ]);
    return { accessToken, refreshToken, imToken };
  }

  private signAccessToken(
    userId: string,
    accountId: string,
    role: string,
  ): Promise<string> {
    return this.jwt.signAsync({ sub: userId, accountId, role });
  }
}
