import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { PrismaService } from 'src/prisma/prisma.service';
import { generateAccountId } from 'src/utils/account-id';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenService } from './refresh-token.service';

export type SafeUser = {
  id: string;
  accountId: string;
  username: string;
  nickname: string;
  avatarUrl: string | null;
  role: string;
  status: string;
  createdAt: Date;
};

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private refreshTokenService: RefreshTokenService,
    private jwt: JwtService,
  ) {}

  async register(dto: RegisterDto) {
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
      },
    });

    return this.issueTokens(user.id, user.username, user.role);
  }

  async login(dto: LoginDto) {
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

    return this.issueTokens(user.id, user.username, user.role);
  }

  async refresh(refreshToken: string) {
    const { token: newRefreshToken, userId } =
      await this.refreshTokenService.rotate(refreshToken);

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

  async me(userId: string): Promise<SafeUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        accountId: true,
        username: true,
        nickname: true,
        avatarUrl: true,
        role: true,
        status: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return user;
  }

  private async issueTokens(userId: string, username: string, role: string) {
    const [accessToken, refreshToken] = await Promise.all([
      this.signAccessToken(userId, username, role),
      this.refreshTokenService.create(userId),
    ]);
    return { accessToken, refreshToken };
  }

  private signAccessToken(
    userId: string,
    username: string,
    role: string,
  ): Promise<string> {
    return this.jwt.signAsync({ sub: userId, username, role });
  }
}
