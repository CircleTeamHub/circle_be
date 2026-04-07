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
import { generateAccountId } from 'src/utils/account-id';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenService, SessionContext } from './refresh-token.service';
import { OpenimService } from 'src/openim/openim.service';

const ME_SELECT = {
  id: true,
  accountId: true,
  username: true,
  nickname: true,
  avatarUrl: true,
  cover: true,
  email: true,
  phoneNumber: true,
  whatsup: true,
  persona: true,
  helloWords: true,
  gender: true,
  role: true,
  status: true,
  lastOnline: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type SafeUser = {
  id: string;
  accountId: string;
  username: string;
  nickname: string;
  avatarUrl: string | null;
  cover: string | null;
  email: string | null;
  phoneNumber: string | null;
  whatsup: string | null;
  persona: string | null;
  helloWords: string | null;
  gender: string;
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
      where: { username: dto.username },
    });
    if (existing) {
      throw new ConflictException('Username already taken');
    }

    const passwordHash = await argon2.hash(dto.password);
    const accountId = generateAccountId();

    const user = await this.prisma.user.create({
      data: {
        accountId,
        username: dto.username,
        passwordHash,
        nickname: dto.nickname || dto.username,
        email: dto.email,
        phoneNumber: dto.phoneNumber,
      },
    });

    // Sync user to OpenIM (non-blocking — failure should not break registration)
    this.openim
      .registerUser(user.id, user.nickname, user.avatarUrl)
      .catch((err) =>
        this.logger.warn(`OpenIM registerUser failed: ${err?.message}`),
      );

    return this.issueTokens(user.id, user.username, user.role, sessionContext);
  }

  async login(dto: LoginDto, sessionContext?: SessionContext) {
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
    });

    if (!user) {
      throw new ForbiddenException('Invalid credentials');
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException('Account is not active');
    }

    const valid = await argon2.verify(user.passwordHash, dto.password);
    if (!valid) {
      throw new ForbiddenException('Invalid credentials');
    }

    return this.issueTokens(user.id, user.username, user.role, sessionContext);
  }

  async refresh(refreshToken: string, sessionContext?: SessionContext) {
    const { token: newRefreshToken, userId } =
      await this.refreshTokenService.rotate(refreshToken, sessionContext);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const accessToken = await this.signAccessToken(
      user.id,
      user.username,
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

    return user;
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
    username: string,
    role: string,
    sessionContext?: SessionContext,
  ) {
    const [accessToken, refreshToken, imToken] = await Promise.all([
      this.signAccessToken(userId, username, role),
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
    username: string,
    role: string,
  ): Promise<string> {
    return this.jwt.signAsync({ sub: userId, username, role });
  }
}
